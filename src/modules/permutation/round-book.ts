import { fail } from '../../api/errors.js';
import { ENGINE_LIMITS } from '../../api/limits.js';
import { constantTimeHexEqual } from '../../core/commitment.js';
import {
  CommandLedger,
  RECEIPT_WIRE_KEYS,
  commandFingerprint,
  fromWireReceipt,
  toWireReceipt,
  type Receipt,
  type StoredReceipt,
  type WireReceipt,
} from '../../core/ledger.js';
import { assertClaimBudget } from '../../core/module.js';
import { payableWithinCap, type Payable } from '../../core/payments.js';
import { normalizeSeed } from '../../core/random.js';
import { add, rational, type Rational } from '../../core/rational.js';
import {
  assertSnapshotKeys,
  assertSnapshotRecord,
  assertSnapshotRevision,
  assertSnapshotSize,
  assertWireHex,
  assertWireString,
  parseSnapshotJson,
  parseWireBigInt,
  snapshotHash,
} from '../../core/snapshot.js';
import { assertBet, betFromParameters, betParameters, betWins, claimSignature } from './bets.js';
import {
  PERMUTATION_ACTIONS,
  PERMUTATION_BOOK_SCHEMA,
  RETIRED_BOOK_SCHEMAS,
  type PermutationAction,
  type PermutationBet,
  type PermutationClaim,
  type PermutationDefinition,
  type PermutationOrder,
  type PermutationRoundBinding,
  type PermutationSettlement,
  type PermutationTranscript,
} from './contracts.js';
import { permutationFingerprint } from './definition.js';
import {
  makePermutationTranscript,
  ordersEqual,
  verifyPermutationTranscript,
} from './derivation.js';
import { deserializePermutationTranscript, serializePermutationTranscript } from './transcript.js';
import { linePayout } from './pricing.js';
import { assertPermutationDefinition } from './validation.js';

export interface PlaceRequest {
  readonly idempotencyKey: string;
  readonly bet: PermutationBet;
  readonly stake: bigint;
}

export interface SettleRequest {
  readonly idempotencyKey: string;
  readonly revealedSeed: string;
  readonly transcript: unknown;
}

export interface WirePermutationClaim {
  readonly key: string;
  readonly code: string;
  readonly parameters: readonly number[];
  readonly stake: string;
}

export interface PermutationBookSnapshot {
  readonly schema: typeof PERMUTATION_BOOK_SCHEMA;
  readonly definition: {
    readonly id: string;
    readonly version: string;
    readonly fingerprint: string;
  };
  /** The published round this book plays; `null` only before it is bound. */
  readonly binding: {
    readonly roundId: string;
    readonly commitment: string;
  } | null;
  readonly terminal: boolean;
  readonly ledgerRevision: number;
  readonly stepRevision: number;
  readonly liquidBalance: string;
  readonly capBasisStake: string | null;
  readonly claims: readonly WirePermutationClaim[];
  /** Present exactly when the round is terminal; `null` otherwise. */
  readonly settlement: {
    readonly roundId: string;
    readonly revealedSeed: string;
    readonly order: readonly number[];
    readonly commitment: string;
    readonly idempotencyKey: string;
  } | null;
  readonly receipts: readonly { readonly fingerprint: string; readonly receipt: WireReceipt }[];
  readonly snapshotHash: string;
}

function assertRequest(value: unknown, path = '$'): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('CLAIM_REJECTED', 'Request must be an object', path);
}

function assertIdempotencyKey(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > ENGINE_LIMITS.maxIdempotencyKeyBytes
  )
    fail('IDEMPOTENCY_CONFLICT', 'Invalid idempotency key', '$.idempotencyKey');
}

/**
 * Per-line stake admissibility, applied identically on the live path and on
 * restore.
 *
 * The quantum check is not housekeeping: `docs/modules/permutation.md` proves
 * that `stake x multiplier` is an exact integer for every legal stake, and that
 * proof is what makes the floor at the credit boundary a no-op rather than a
 * truncation the player silently pays for. A stake off the quantum breaks the
 * theorem, so it is refused rather than rounded.
 */
function assertLineStake(
  definition: PermutationDefinition,
  stake: unknown,
  path = '$.stake',
): asserts stake is bigint {
  // Reported as a refused claim rather than as `INVALID_RATIONAL`: a stake that
  // is not a positive bounded integer is a bad bet, and every other rejection
  // on this path says so with the same code.
  if (
    typeof stake !== 'bigint' ||
    stake <= 0n ||
    stake.toString(2).length > ENGINE_LIMITS.maxBigIntBits
  )
    fail('CLAIM_REJECTED', 'Stake must be a positive bounded integer', path);
  const amount = stake;
  if (amount % definition.stakeQuantum !== 0n)
    fail('CLAIM_REJECTED', 'Stake is not a multiple of the stake quantum', path);
  if (amount < definition.minLineStake || amount > definition.maxLineStake)
    fail('CLAIM_REJECTED', 'Stake is outside the per-line bounds', path);
}

/**
 * The ticket ceiling, kept **separate** from the per-line bounds on purpose.
 *
 * A running total is state, and an idempotent retry must not be measured
 * against a total that already contains the original. Splitting the two lets
 * the per-line checks run before the ledger gate — where a malformed request
 * should be refused whether or not it is a replay — while the cumulative one
 * runs inside it, on the path the ledger only takes for a genuinely new
 * command.
 */
function assertTicketCeiling(
  definition: PermutationDefinition,
  total: bigint,
  path = '$.stake',
): void {
  if (total > definition.maxTicketStake)
    fail('CLAIM_REJECTED', 'Ticket stake exceeds the round ceiling', path);
}

/**
 * Validates and freezes a round binding arriving from a host or a snapshot.
 *
 * Held to the transcript codec's rules for the same two fields, so a binding and
 * the transcript it will be compared against cannot disagree about what a legal
 * round id or commitment looks like.
 */
function freezeBinding(value: unknown, path = '$.binding'): PermutationRoundBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('CLAIM_REJECTED', 'Expected a round binding object', path);
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'commitment' || keys[1] !== 'roundId')
    fail('CLAIM_REJECTED', 'A round binding carries exactly a roundId and a commitment', path);
  const binding = value as PermutationRoundBinding;
  if (
    typeof binding.roundId !== 'string' ||
    binding.roundId.length === 0 ||
    Buffer.byteLength(binding.roundId, 'utf8') > ENGINE_LIMITS.maxIdentifierBytes ||
    /[\u0000-\u001f\u007f]/u.test(binding.roundId)
  )
    fail('CLAIM_REJECTED', 'Expected a bounded printable round id', `${path}.roundId`);
  if (typeof binding.commitment !== 'string' || !/^[0-9a-f]{64}$/u.test(binding.commitment))
    fail('CLAIM_REJECTED', 'Expected canonical 32-byte hexadecimal', `${path}.commitment`);
  return Object.freeze({ roundId: binding.roundId, commitment: binding.commitment });
}

/** True when two bindings name the same published round. */
function bindingsEqual(left: PermutationRoundBinding, right: PermutationRoundBinding): boolean {
  return left.roundId === right.roundId && constantTimeHexEqual(left.commitment, right.commitment);
}

/**
 * A `place` command's identity — and it includes the round it was placed into.
 *
 * The round is part of what the player did, not context around it: the same bet
 * for the same stake is a different command in a different round, because it is
 * a claim on a different draw. Binding it here is what makes the binding
 * **tamper-evident in a snapshot**, and that matters most exactly where the
 * snapshot has nothing else to check it against.
 *
 * A terminal snapshot could reconcile its binding against the settlement, which
 * re-derives from the revealed seed. A *staked, non-terminal* one has no
 * settlement and no seed — so without this, an operator could take a ticket in
 * round A, rewrite the reconnect snapshot's binding to round B, restore, and
 * settle against B. Every balance would reconcile, because none of them moved.
 * With this, rewriting the binding invalidates every `place` receipt in the log.
 */
function placeFingerprint(
  binding: PermutationRoundBinding,
  bet: PermutationBet,
  stake: bigint,
): string {
  return commandFingerprint('place', [
    binding.roundId,
    binding.commitment,
    bet.code,
    ...betParameters(bet),
    stake,
  ]);
}

/**
 * The settle command's identity: the revealed seed and the whole transcript.
 *
 * One definition, used by `settle()` and by `restore()`, so the fingerprint a
 * snapshot is checked against is the same function that minted it rather than a
 * second spelling of the same idea.
 */
function settleFingerprint(revealedSeed: string, transcript: PermutationTranscript): string {
  return commandFingerprint('settle', [revealedSeed, serializePermutationTranscript(transcript)]);
}

/**
 * A multi-bet round book: several independent claims on one permutation draw,
 * settled together against the published paytable.
 *
 * Three properties are worth stating up front, because each one is a place where
 * a plausible implementation would be wrong:
 *
 * 1. **One ledger, many positions.** Every bet is separately funded and each one
 *    therefore raises the round's cap basis. Pinning the ceiling to the first
 *    stake would crush a legitimate ticket: at a 10x cap, 1 chip on a loser
 *    followed by 10,000 on a winner would pay 10 against a real claim of tens of
 *    thousands.
 * 2. **Claims are distinct behaviourally, not nominally.** `first {item}` and
 *    `slot {item, 0}` win on the identical set of orders, so a ticket may carry
 *    one of them, never both. Without that rule the per-line ceiling means
 *    nothing — the whole budget goes onto copies of the best line, spelled
 *    differently — and the round's maximum credit stops being a maximum.
 * 3. **Settlement needs a proof, not an assertion.** `settle()` takes the
 *    revealed seed and re-verifies the transcript through the module's own
 *    verifier before a single claim is scored. A book that settled against an
 *    unverified order would pay out whatever it was handed.
 * 4. **A verified proof is not enough; it must be the proof for _this_ round.**
 *    Every transcript this module builds is internally valid and verifies
 *    against its own seed, so "it verifies" says nothing about *which* round it
 *    is. A book that checked only the proof would let an operator holding a
 *    placed ticket search round ids for one the ticket loses on, settle against
 *    it, and hand the player a receipt in which every artefact verifies. So the
 *    book is **bound** to a published round before it may take a single bet, and
 *    `settle()` refuses a transcript naming any other. See
 *    `PermutationRoundBinding`.
 */
export class PermutationBook {
  readonly #ledger: CommandLedger;
  readonly #claims = new Map<string, PermutationClaim>();
  readonly #signatures = new Map<string, string>();
  #binding: PermutationRoundBinding | undefined;
  #stakedTotal = 0n;
  #stepRevision = 0;
  #terminal = false;
  #settlement: PermutationSettlement | undefined;

  /**
   * A book is constructed bound, or bound by `bind()` before its first bet.
   *
   * The binding is optional here only because the lifecycle contract's
   * `book.create(definition)` factory has no round to hand over — see
   * `module.ts`. An unbound book is inert: it can be inspected and serialized,
   * and `place()` refuses it, so the two-step path cannot take money before the
   * round it plays has been published.
   */
  constructor(
    readonly definition: PermutationDefinition,
    binding?: PermutationRoundBinding,
  ) {
    assertPermutationDefinition(definition);
    if (binding !== undefined) this.#binding = freezeBinding(binding);
    this.#ledger = new CommandLedger({ maxWinMultiple: definition.maxWinMultiple });
  }

  /** The published round this book plays, or `undefined` before it is bound. */
  get binding(): PermutationRoundBinding | undefined {
    return this.#binding;
  }

  /**
   * Pins the published round. Callable once, and only before the first bet.
   *
   * "Before the first bet" is the whole control. Binding a round after a ticket
   * exists is the attack it prevents, spelled with an extra call: the operator
   * would place, look, then choose. So a book that already holds a claim — or
   * that is already bound, or already terminal — refuses.
   */
  bind(binding: PermutationRoundBinding): void {
    const next = freezeBinding(binding);
    if (this.#binding !== undefined)
      fail('CLAIM_REJECTED', 'Round is already bound to a published commitment', '$.binding');
    if (this.#claims.size !== 0 || this.#terminal)
      fail('CLAIM_REJECTED', 'Round cannot be bound after it has accepted a bet', '$.binding');
    this.#binding = next;
  }

  get claims(): readonly PermutationClaim[] {
    return Object.freeze([...this.#claims.values()]);
  }
  get stakedTotal(): bigint {
    return this.#stakedTotal;
  }
  get liquidBalance(): bigint {
    return this.#ledger.liquidBalance;
  }
  get capBasisStake(): bigint | undefined {
    return this.#ledger.capBasisStake;
  }
  get ledgerRevision(): number {
    return this.#ledger.ledgerRevision;
  }
  get terminal(): boolean {
    return this.#terminal;
  }
  get settledOrder(): PermutationOrder | undefined {
    return this.#settlement?.order;
  }

  /**
   * The exact total return if the settled order were `order`.
   *
   * Public, and therefore validated: `betWins` answers `false` for anything it
   * cannot read, so an unchecked argument would quietly price a whole ticket at
   * zero rather than say it was handed something that is not an order.
   */
  grossFor(order: PermutationOrder): Rational {
    assertSettledOrder(this.definition, order, '$.order', 'CLAIM_REJECTED');
    return this.claims
      .filter((claim) => betWins(this.definition, claim.bet, order))
      .reduce((total, claim) => add(total, claim.payout), rational(0n));
  }

  async place(request: PlaceRequest): Promise<Receipt<PermutationAction>> {
    assertRequest(request);
    assertIdempotencyKey(request.idempotencyKey);
    assertBet(request.bet, this.definition);
    assertLineStake(this.definition, request.stake);
    const bet = request.bet;
    // Ahead of the ledger, not inside it: the command's own identity is a
    // function of the round, so an unbound book has no `place` command to
    // fingerprint, let alone to store against an idempotency key. The binding is
    // immutable once set and `bind()` refuses a book that holds a claim, so this
    // read cannot go stale between here and the serialized section below.
    const binding = this.#binding;
    if (binding === undefined)
      fail(
        'CLAIM_REJECTED',
        'Round has no published commitment; bind it before accepting a bet',
        '$.binding',
      );
    const payout = linePayout(this.definition, bet.code, request.stake);
    const signature = claimSignature(this.definition, bet);
    const fingerprint = placeFingerprint(binding, bet, request.stake);
    return this.#ledger.execute<PermutationAction>(request.idempotencyKey, fingerprint, () => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is already terminal');
      assertClaimBudget(this.#claims.size, this.definition.maxOpenBets);
      // Inside the serialized section, and only for a new command: two
      // concurrent places must not both clear a ceiling taken outside it, and a
      // replayed one must not be charged twice against it.
      assertTicketCeiling(this.definition, this.#stakedTotal + request.stake);
      if (this.#signatures.has(signature))
        fail('CLAIM_REJECTED', 'Ticket already carries this claim; raise its stake', '$.bet');
      const receipt = this.#ledger.mint(
        request.idempotencyKey,
        fingerprint,
        'place',
        this.#stepRevision,
        request.stake,
        0n,
        false,
      );
      // Independently funded: each bet raises the ceiling by what it risked.
      this.#ledger.fundStake(request.stake, 'external');
      this.#stakedTotal += request.stake;
      this.#signatures.set(signature, request.idempotencyKey);
      this.#claims.set(
        request.idempotencyKey,
        Object.freeze({
          key: request.idempotencyKey,
          bet: Object.freeze({ ...bet }) as PermutationBet,
          stake: request.stake,
          payout,
          signature,
        }),
      );
      return receipt;
    });
  }

  async settle(request: SettleRequest): Promise<Receipt<PermutationAction>> {
    assertRequest(request);
    assertIdempotencyKey(request.idempotencyKey);
    const revealedSeed = normalizeSeed(request.revealedSeed);
    const transcript = deserializePermutationTranscript(request.transcript);
    const fingerprint = settleFingerprint(revealedSeed, transcript);
    return this.#ledger.execute<PermutationAction>(request.idempotencyKey, fingerprint, () => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is already terminal');
      const binding = this.#binding;
      if (binding === undefined)
        fail('CLAIM_REJECTED', 'Round has no published commitment to settle against', '$.binding');
      // Asked *before* the proof is verified, because it is the more fundamental
      // question: not "is this a valid transcript" — every transcript this
      // module builds is — but "is this the round this book was bound to". A
      // round id and a commitment that disagree with the binding are refused
      // whether or not the seed opens them.
      if (transcript.roundId !== binding.roundId)
        fail(
          'COMMITMENT_MISMATCH',
          'Transcript settles a different round than the one this book is bound to',
          '$.transcript.roundId',
        );
      if (!constantTimeHexEqual(transcript.commitment, binding.commitment))
        fail(
          'COMMITMENT_MISMATCH',
          'Transcript does not open the commitment published for this round',
          '$.transcript.commitment',
        );
      const verification = verifyPermutationTranscript(revealedSeed, this.definition, transcript);
      if (!verification.ok)
        fail('INVALID_TRANSCRIPT', verification.message, verification.path, {
          verificationCode: verification.code,
        });
      const theoretical = this.grossFor(transcript.order);
      const close = (result: Payable): Receipt<PermutationAction> => {
        const receipt = this.#ledger.mint(
          request.idempotencyKey,
          fingerprint,
          'settle',
          transcript.reveals.length,
          0n,
          result.credited,
          result.capped,
        );
        this.#terminal = true;
        this.#stepRevision = transcript.reveals.length;
        this.#settlement = Object.freeze({
          roundId: transcript.roundId,
          revealedSeed,
          order: transcript.order,
          commitment: transcript.commitment,
          idempotencyKey: request.idempotencyKey,
        });
        return receipt;
      };
      // A round that took no stake has no ceiling to credit against, so there is
      // nothing to pay and nothing to measure. `creditClaim` would (correctly)
      // reject it as a state-machine bug, so the empty ticket is closed here.
      return this.#ledger.capBasisStake === undefined
        ? close(Object.freeze({ theoretical, credited: 0n, capped: false }))
        : this.#ledger.creditClaim(theoretical, close);
    });
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }

  snapshot(): PermutationBookSnapshot {
    const capBasisStake = this.#ledger.capBasisStake;
    const base = {
      schema: PERMUTATION_BOOK_SCHEMA,
      definition: Object.freeze({
        id: this.definition.id,
        version: this.definition.version,
        fingerprint: permutationFingerprint(this.definition),
      }),
      binding:
        this.#binding === undefined
          ? null
          : Object.freeze({
              roundId: this.#binding.roundId,
              commitment: this.#binding.commitment,
            }),
      terminal: this.#terminal,
      ledgerRevision: this.#ledger.ledgerRevision,
      stepRevision: this.#stepRevision,
      liquidBalance: String(this.#ledger.liquidBalance),
      capBasisStake: capBasisStake === undefined ? null : String(capBasisStake),
      // The claim's payout is deliberately absent: it is `stake x paytable[code]`
      // and therefore derivable, and a money-bearing field a snapshot does not
      // carry is a money-bearing field nobody can rewrite.
      claims: Object.freeze(
        this.claims.map((claim) =>
          Object.freeze({
            key: claim.key,
            code: claim.bet.code,
            parameters: Object.freeze([...betParameters(claim.bet)]),
            stake: String(claim.stake),
          }),
        ),
      ),
      settlement:
        this.#settlement === undefined
          ? null
          : Object.freeze({
              roundId: this.#settlement.roundId,
              revealedSeed: this.#settlement.revealedSeed,
              order: Object.freeze([...this.#settlement.order]),
              commitment: this.#settlement.commitment,
              idempotencyKey: this.#settlement.idempotencyKey,
            }),
      receipts: Object.freeze(
        this.#ledger.entries().map((stored) =>
          Object.freeze({
            fingerprint: stored.fingerprint,
            receipt: toWireReceipt(stored.receipt),
          }),
        ),
      ),
    };
    return Object.freeze({ ...base, snapshotHash: snapshotHash(base) });
  }

  /**
   * Re-validates a snapshot rather than trusting it.
   *
   * Everything money-bearing is re-derived and reconciled, never read:
   *
   * - each claim's **bet and stake** are checked against the `place` receipt's
   *   own command fingerprint, so a claim rewritten *without* its receipt is
   *   refused — see the paragraph below for the much narrower thing that buys;
   * - each claim's **payout** is recomputed from `(code, stake)` and the
   *   published paytable, and is not in the snapshot at all;
   * - the **settled credit** is recomputed by scoring the restored claims
   *   against the recorded settled order and re-applying the cap, then compared
   *   against the settle receipt — so rewriting the order, or the credit, or
   *   both inconsistently, is rejected;
   * - the **balances** are reconstructed from the receipt log and reconciled
   *   before `restoreBalances` installs them.
   *
   * The checksum is not the control. Anyone able to rewrite a field can
   * recompute the hash over it, so every tamper case in this module's tests
   * re-seals its mutation and is judged on the validation underneath.
   *
   * **Nor is the command fingerprint a control against a determined rewrite,
   * and an earlier version of this comment claimed it was.** It said "a
   * rewritten ticket cannot survive its own log". It can.
   * `commandFingerprint` is an unkeyed SHA-256 over public fields and it is an
   * export of this package, so a forger who can write to the snapshot store
   * rewrites the log *alongside* the ticket. Inserting a `full`-order line for
   * 5,000 chips that was never placed, minting its `place` receipt with the
   * exported helper, renumbering the ledger, raising `capBasisStake` and
   * `liquidBalance` and re-sealing the checksum produces a snapshot this method
   * accepts — restoring a balance of 576,120 against an honest 120 — *while the
   * caller passes the correct published round as `expected`*. Deleting a line
   * works the same way. `tests/security/snapshot-mutation.test.ts` carries both
   * directions as executed tests rather than as a caveat, because a disclosed
   * exposure that nothing runs is a sentence, not a boundary.
   *
   * So the residual is not "which round this snapshot belongs to". It is **the
   * entire ticket and its accounting**: which lines were placed, for how much,
   * and what was credited. `expected` is orthogonal to it and does not narrow
   * it. Every re-derivation above is a consistency check over attacker-supplied
   * bytes, and consistency is exactly what a forger who holds the whole snapshot
   * can supply.
   *
   * Closing it needs authentication, which this module does not provide and
   * cannot provide by hashing: either the snapshot store is authenticated
   * (integrity-protected storage the RGS controls, not a field inside the
   * document), or the ticket and settlement are bound under a key the forger
   * does not hold. The second is what `aether-order/docs/ENGINE.md` §7.6/§7.8
   * specifies and what `src/modules/permutation/aether/receipt.ts` implements —
   * `ticketDigest` and `settlementDigest` inside an Ed25519-signed receipt core.
   * A deployment that reconnects real tickets from an unauthenticated store has
   * this exposure whatever it passes as `expected`; `docs/integration-checklist.md`
   * asks for the control explicitly.
   *
   * One field is an honest exception and is documented as one: the settlement's
   * `commitment` is a *label* naming which published proof settled this round.
   * A snapshot cannot re-derive it — that needs the revealed seed — so restore
   * checks its shape and nothing more. The proof of a settlement is the
   * transcript, verified against the seed; the snapshot is reconnect state.
   *
   * **A snapshot cannot be trusted to say which round it belongs to, and this
   * method does not ask it.** Every `place` receipt's command fingerprint covers
   * `(roundId, commitment)` along with the bet and the stake, so on a snapshot
   * carrying any placement a *partial* rewrite — the binding moved and the
   * receipts left alone — contradicts every one of them and is refused below; a
   * settled snapshot is refused twice over, since its settlement re-derives from
   * the seed and must name the round the binding does.
   *
   * That is the whole of what the fingerprint buys, and it is worth stating what
   * it does not. `commandFingerprint` is an unkeyed SHA-256 over public fields
   * and `makePermutationTranscript` is a
   * public export, so anyone able to rewrite the snapshot can recompute every
   * place fingerprint, the settlement and the checksum, and produce a wholly
   * consistent snapshot of a *different* round. That rewrite is
   * indistinguishable from the truth by any in-process check, at every stake
   * level, staked or settled. It is not caught here. It cannot be.
   *
   * So `expected` — the round the caller published — is **required whenever the
   * snapshot carries a binding**, and it is the only thing that decides which
   * round a restored book plays. The snapshot's own binding is reconciled
   * against it, never used as the source. An operator always holds that value,
   * because publishing it is what opened the round; a caller that does not hold
   * it cannot tell an honest snapshot from a re-pointed one, and must not be
   * handed a book that pretends otherwise.
   *
   * A snapshot with **no binding** needs no evidence. It can carry no claim and
   * no settlement — enforced below — so it is a book that has done nothing, and
   * reconstructing one is indistinguishable from calling
   * `new PermutationBook(definition)`, which any caller may do anyway. It is
   * therefore the only snapshot the lifecycle contract's two-argument
   * `book.restore(definition, snapshot)` can restore, and deliberately so: that
   * signature has no round to hand over, so the one state it can produce is the
   * one in which no money is at risk. Same argument as the `create` factory.
   */
  static restore(
    definition: PermutationDefinition,
    input: string | object,
    expected?: PermutationRoundBinding,
  ): PermutationBook {
    assertPermutationDefinition(definition);
    const raw = parseSnapshotInput(input);
    if (raw.snapshotHash !== snapshotHash({ ...raw, snapshotHash: undefined }))
      fail('INVALID_SNAPSHOT', 'Snapshot hash is invalid', '$.snapshotHash');
    if (
      raw.definition.id !== definition.id ||
      raw.definition.version !== definition.version ||
      !constantTimeHexEqual(raw.definition.fingerprint, permutationFingerprint(definition))
    )
      fail('DEFINITION_MISMATCH', 'Snapshot belongs to another definition', '$.definition');

    const binding = raw.binding === null ? undefined : freezeBinding(raw.binding, '$.binding');
    if (expected !== undefined) {
      const wanted = freezeBinding(expected, '$.expected');
      if (binding === undefined || !bindingsEqual(binding, wanted))
        fail('COMMITMENT_MISMATCH', 'Snapshot belongs to another round', '$.binding');
    } else if (binding !== undefined) {
      // The bound snapshot's round comes from the caller or from nowhere. A
      // consistent whole-round rewrite reconciles perfectly against everything
      // below, so reconstructing one without out-of-band evidence would be this
      // class asserting a round it has no way to know.
      fail(
        'CLAIM_REJECTED',
        'Restoring a bound snapshot needs the round the caller published: pass it as the third argument to PermutationBook.restore()',
        '$.expected',
      );
    }
    // An unbound book cannot have taken a bet or settled, so a snapshot claiming
    // otherwise is describing a state this class cannot reach.
    if (binding === undefined && (raw.claims.length !== 0 || raw.terminal))
      fail('INVALID_SNAPSHOT', 'Snapshot staked or settled an unbound round', '$.binding');

    const book = new PermutationBook(definition, binding);
    book.#terminal = raw.terminal;
    book.#stepRevision = assertSnapshotRevision(raw.stepRevision, '$.stepRevision');

    for (let index = 0; index < raw.claims.length; index += 1) {
      const entry = raw.claims[index] as WirePermutationClaim;
      const path = `$.claims[${index}]`;
      const bet = betFromParameters(definition, entry.code, entry.parameters, path);
      const stake = parseWireBigInt(entry.stake, `${path}.stake`);
      assertLineStake(definition, stake, `${path}.stake`);
      assertTicketCeiling(definition, book.#stakedTotal + stake, `${path}.stake`);
      const signature = claimSignature(definition, bet);
      if (book.#signatures.has(signature))
        fail('INVALID_SNAPSHOT', 'Snapshot repeats a behavioural claim', `${path}.code`);
      if (book.#claims.has(entry.key))
        fail('INVALID_SNAPSHOT', 'Snapshot claim keys are not unique', `${path}.key`);
      book.#signatures.set(signature, entry.key);
      book.#stakedTotal += stake;
      book.#claims.set(
        entry.key,
        Object.freeze({
          key: entry.key,
          bet,
          stake,
          payout: linePayout(definition, bet.code, stake),
          signature,
        }),
      );
    }
    if (book.#claims.size > definition.maxOpenBets)
      fail('INVALID_SNAPSHOT', 'Snapshot exceeds the declared claim budget', '$.claims');

    const settlement = restoredSettlement(definition, raw);
    // A settled round settled the round it was bound to. Rewriting one half of
    // that pair is what a partial tamper looks like, and it is refused here; the
    // consistent rewrite of both halves is what `expected` is for.
    if (
      settlement !== undefined &&
      binding !== undefined &&
      !bindingsEqual(binding, settlement.record)
    )
      fail(
        'INVALID_SNAPSHOT',
        'Snapshot settled a different round than the one it is bound to',
        '$.settlement.roundId',
      );
    let reconstructedLiquid = 0n;
    let stakedTotal = 0n;
    let placements = 0;
    let settled = false;
    let settleReceipt: Receipt<PermutationAction> | undefined;
    const stored: StoredReceipt<PermutationAction>[] = [];
    for (let index = 0; index < raw.receipts.length; index += 1) {
      const entry = raw.receipts[index] as PermutationBookSnapshot['receipts'][number];
      stored.push({
        fingerprint: entry.fingerprint,
        receipt: fromWireReceipt<PermutationAction>(entry.receipt, PERMUTATION_ACTIONS),
      });
    }
    book.#ledger.install(stored, book.#stepRevision, (receipt) => {
      if (receipt.action === 'place') {
        // A permutation round has exactly one frame, so every stake is fenced at
        // revision 0 and only the settle receipt moves it. `capped` is the same
        // kind of field: `place` mints it `false` unconditionally, because a
        // stake is not a credit and nothing about it can meet a ceiling. Neither
        // carries semantics here, which is exactly why an unpinned one is a
        // receipt field a snapshot could rewrite unchallenged — and a restored
        // log that reports a capped stake is an audit record that disagrees with
        // the operator's own.
        if (
          settled ||
          receipt.debited <= 0n ||
          receipt.credited !== 0n ||
          receipt.frameRevision !== 0 ||
          receipt.capped
        )
          fail('INVALID_SNAPSHOT', 'Receipt sequence violates the round state machine');
        const claim = raw.claims[placements];
        const restored = claim === undefined ? undefined : book.#claims.get(claim.key);
        if (
          claim === undefined ||
          restored === undefined ||
          receipt.idempotencyKey !== claim.key ||
          receipt.debited !== restored.stake ||
          binding === undefined ||
          receipt.commandFingerprint !== placeFingerprint(binding, restored.bet, restored.stake)
        )
          fail('INVALID_SNAPSHOT', 'Receipt does not match the restored claim', '$.claims');
        stakedTotal += receipt.debited;
        placements += 1;
      } else {
        if (
          settled ||
          receipt.debited !== 0n ||
          receipt.frameRevision !== definition.items.length - 1
        )
          fail('INVALID_SNAPSHOT', 'Receipt sequence violates the round state machine');
        reconstructedLiquid += receipt.credited;
        settleReceipt = receipt;
        settled = true;
      }
    });

    const capBasisStake =
      raw.capBasisStake === null
        ? undefined
        : parseWireBigInt(raw.capBasisStake, '$.capBasisStake');
    const expectedStepRevision = settled ? definition.items.length - 1 : 0;
    if (
      placements !== book.#claims.size ||
      settled !== book.#terminal ||
      settled !== (settlement !== undefined) ||
      book.#stepRevision !== expectedStepRevision ||
      (placements === 0) !== (capBasisStake === undefined) ||
      (capBasisStake !== undefined && capBasisStake !== stakedTotal) ||
      stakedTotal !== book.#stakedTotal
    )
      fail('INVALID_SNAPSHOT', 'Snapshot state invariants failed');
    if (reconstructedLiquid !== parseWireBigInt(raw.liquidBalance, '$.liquidBalance', true))
      fail('INVALID_SNAPSHOT', 'Snapshot accounting does not conserve liquid value');

    if (settlement !== undefined && settleReceipt !== undefined) {
      // The settle receipt's own fingerprint is `('settle', [seed, serialized
      // transcript])`, and the transcript above was rebuilt from the seed rather
      // than read — so this binds the receipt to a proof, not to a claim about
      // one.
      if (settleReceipt.commandFingerprint !== settlement.fingerprint)
        fail(
          'INVALID_SNAPSHOT',
          'Settle receipt does not match the re-derived proof',
          '$.settlement',
        );
      // The credit is recomputed from the restored claims and the re-derived
      // order, then capped exactly as the live path capped it: before the settle
      // credit the round has withdrawn nothing, so the already-liquid term is
      // zero.
      const theoretical = book.grossFor(settlement.proof.order);
      const expectedCredit =
        capBasisStake === undefined
          ? { credited: 0n, capped: false }
          : payableWithinCap(theoretical, capBasisStake, definition.maxWinMultiple, 0n);
      if (
        settleReceipt.credited !== expectedCredit.credited ||
        settleReceipt.capped !== expectedCredit.capped
      )
        fail(
          'INVALID_SNAPSHOT',
          'Settled credit does not re-derive from the restored ticket and order',
          '$.settlement.order',
        );
      // Every receipt's idempotency key is named by the state that receipt
      // produced: a `place` key by its claim, and the `settle` key by the
      // settlement record. Without this the settle key is the one field a
      // snapshot rewrites unchallenged, which puts the restored receipt log out
      // of step with the operator's command log and turns an idempotent retry of
      // the original settle into an error instead of the original receipt.
      if (settleReceipt.idempotencyKey !== settlement.record.idempotencyKey)
        fail(
          'INVALID_SNAPSHOT',
          'Settle receipt does not carry the key the settlement records',
          '$.settlement.idempotencyKey',
        );
      book.#settlement = settlement.record;
    }

    book.#ledger.restoreBalances({
      ledgerRevision: assertSnapshotRevision(raw.ledgerRevision, '$.ledgerRevision'),
      liquidBalance: reconstructedLiquid,
      capBasisStake,
    });
    return book;
  }
}

/**
 * Rebuilds a settled round's proof from the seed the snapshot carries.
 *
 * This is the difference between a snapshot that *asserts* how a round settled
 * and one that can be **checked**. Reconciling the credit alone is not enough:
 * two different orders can pay a ticket the same amount — trivially, any two
 * orders under which every line loses — so a snapshot naming the wrong order
 * would restore cleanly under a recomputed checksum, and a host would then show
 * a settled column that never happened.
 *
 * So the seed is re-expanded through the module's own derivation and the result
 * is required to match the recorded order and commitment exactly, with the
 * commitment compared in constant time. The settle receipt's command
 * fingerprint is then recomputed from that rebuilt transcript, which binds the
 * money-bearing receipt to a proof rather than to a claim about one.
 *
 * Publishing the seed inside a *terminal* snapshot costs nothing: revealing it
 * is what closes the round, and a snapshot that carries it is exactly as
 * disclosing as the transcript the player already holds.
 */
function restoredSettlement(
  definition: PermutationDefinition,
  raw: PermutationBookSnapshot,
):
  | {
      readonly record: PermutationSettlement;
      readonly proof: PermutationTranscript;
      readonly fingerprint: string;
    }
  | undefined {
  if (raw.settlement === null) return undefined;
  const { roundId, revealedSeed, order, commitment, idempotencyKey } = raw.settlement;
  assertSettledOrder(definition, order, '$.settlement.order', 'INVALID_SNAPSHOT');
  let proof: PermutationTranscript;
  try {
    proof = makePermutationTranscript(revealedSeed, definition, roundId);
  } catch {
    // A seed or round id the derivation refuses is a bad snapshot, not a bad
    // seed: the caller handed us reconnect state, so it fails in that taxonomy.
    fail('INVALID_SNAPSHOT', 'Snapshot settlement does not re-derive', '$.settlement');
  }
  if (!ordersEqual(proof.order, order) || !constantTimeHexEqual(proof.commitment, commitment))
    fail(
      'INVALID_SNAPSHOT',
      'Recorded settlement does not match the order the revealed seed derives',
      '$.settlement.order',
    );
  return Object.freeze({
    record: Object.freeze({
      roundId,
      revealedSeed,
      order: proof.order,
      commitment: proof.commitment,
      idempotencyKey,
    }),
    proof,
    fingerprint: settleFingerprint(revealedSeed, proof),
  });
}

/**
 * A settled order is a genuine permutation of the draw.
 *
 * Indexed rather than `forEach`, which skips holes: a sparse array has the right
 * length and no own entries, so every element check would pass without running
 * once.
 */
function assertSettledOrder(
  definition: PermutationDefinition,
  order: unknown,
  path: string,
  code: 'INVALID_SNAPSHOT' | 'CLAIM_REJECTED',
): asserts order is PermutationOrder {
  const size = definition.items.length;
  if (!Array.isArray(order) || order.length !== size)
    fail(code, 'Settled order does not match the draw size', path);
  const seen = new Set<number>();
  for (let index = 0; index < size; index += 1) {
    const item: unknown = order[index];
    if (
      !Number.isSafeInteger(item) ||
      (item as number) < 0 ||
      (item as number) >= size ||
      seen.has(item as number)
    )
      fail(code, 'Settled order is not a permutation', `${path}[${index}]`);
    seen.add(item as number);
  }
}

function parseSnapshotInput(input: string | object): PermutationBookSnapshot {
  const value: unknown = typeof input === 'string' ? parseSnapshotJson(input) : input;
  const candidate = assertSnapshotRecord(value, '$');
  // Ahead of the key set, so a retired schema is named as one. A `v1` snapshot
  // is missing `binding` and would otherwise be reported as a malformed object,
  // which is the least useful thing to tell an operator holding a real snapshot
  // this build will never accept. It cannot be migrated forward: the field it
  // lacks is the published commitment, and nothing in a `v1` snapshot says what
  // that was. See `PERMUTATION_BOOK_SCHEMA`.
  if (typeof candidate.schema === 'string' && RETIRED_BOOK_SCHEMAS.includes(candidate.schema))
    fail(
      'UNSUPPORTED_VERSION',
      'Snapshot schema is retired and has no migration; the round binding it lacks cannot be reconstructed',
      '$.schema',
    );
  assertSnapshotKeys(
    candidate,
    [
      'schema',
      'definition',
      'binding',
      'terminal',
      'ledgerRevision',
      'stepRevision',
      'liquidBalance',
      'capBasisStake',
      'claims',
      'settlement',
      'receipts',
      'snapshotHash',
    ],
    '$',
  );
  if (
    candidate.schema !== PERMUTATION_BOOK_SCHEMA ||
    typeof candidate.terminal !== 'boolean' ||
    !Number.isSafeInteger(candidate.ledgerRevision) ||
    !Number.isSafeInteger(candidate.stepRevision) ||
    !Array.isArray(candidate.claims) ||
    !Array.isArray(candidate.receipts)
  )
    fail('INVALID_SNAPSHOT', 'Snapshot scalar fields are invalid', '$');

  const definition = assertSnapshotRecord(candidate.definition, '$.definition');
  assertSnapshotKeys(definition, ['id', 'version', 'fingerprint'], '$.definition');
  assertWireString(definition.id, '$.definition.id');
  assertWireString(definition.version, '$.definition.version');
  assertWireHex(definition.fingerprint, '$.definition.fingerprint');

  if (candidate.binding !== null) {
    const binding = assertSnapshotRecord(candidate.binding, '$.binding');
    assertSnapshotKeys(binding, ['roundId', 'commitment'], '$.binding');
    assertWireString(binding.roundId, '$.binding.roundId');
    assertWireHex(binding.commitment, '$.binding.commitment');
  }

  assertWireString(candidate.liquidBalance, '$.liquidBalance');
  if (candidate.capBasisStake !== null)
    assertWireString(candidate.capBasisStake, '$.capBasisStake');

  if (candidate.claims.length > ENGINE_LIMITS.maxRoundClaims)
    fail('INVALID_SNAPSHOT', 'Claims must be a bounded array', '$.claims');
  for (let index = 0; index < candidate.claims.length; index += 1) {
    const claim = assertSnapshotRecord(candidate.claims[index], `$.claims[${index}]`);
    assertSnapshotKeys(claim, ['key', 'code', 'parameters', 'stake'], `$.claims[${index}]`);
    assertWireString(claim.key, `$.claims[${index}].key`);
    assertWireString(claim.code, `$.claims[${index}].code`);
    assertWireString(claim.stake, `$.claims[${index}].stake`);
    if (!Array.isArray(claim.parameters))
      fail('INVALID_SNAPSHOT', 'Bet parameters must be an array', `$.claims[${index}].parameters`);
  }

  if (candidate.settlement !== null) {
    const settlement = assertSnapshotRecord(candidate.settlement, '$.settlement');
    assertSnapshotKeys(
      settlement,
      ['roundId', 'revealedSeed', 'order', 'commitment', 'idempotencyKey'],
      '$.settlement',
    );
    assertWireString(settlement.roundId, '$.settlement.roundId');
    // Bounded here as a wire string and nothing more, exactly like a claim key:
    // the strict key rules belong to `fromWireReceipt`, and restore requires
    // this value to equal the settle receipt's, so it inherits them.
    // `assertIdempotencyKey` would report `IDEMPOTENCY_CONFLICT` from inside a
    // snapshot parser, which is the wrong taxonomy for reconnect state.
    assertWireString(settlement.idempotencyKey, '$.settlement.idempotencyKey');
    assertWireHex(settlement.revealedSeed, '$.settlement.revealedSeed');
    if (!Array.isArray(settlement.order))
      fail('INVALID_SNAPSHOT', 'Settled order must be an array', '$.settlement.order');
    assertWireHex(settlement.commitment, '$.settlement.commitment');
  }

  if (candidate.receipts.length > ENGINE_LIMITS.maxReceipts)
    fail('INVALID_SNAPSHOT', 'Receipts must be a bounded array', '$.receipts');
  // Indexed rather than `forEach`: a hole would otherwise be skipped here and
  // then spread into the ledger's install list as `undefined`.
  for (let index = 0; index < candidate.receipts.length; index += 1) {
    const entry = assertSnapshotRecord(candidate.receipts[index], `$.receipts[${index}]`);
    assertSnapshotKeys(entry, ['fingerprint', 'receipt'], `$.receipts[${index}]`);
    assertWireHex(entry.fingerprint, `$.receipts[${index}].fingerprint`);
    const receipt = assertSnapshotRecord(entry.receipt, `$.receipts[${index}].receipt`);
    assertSnapshotKeys(receipt, RECEIPT_WIRE_KEYS, `$.receipts[${index}].receipt`);
  }

  assertWireHex(candidate.snapshotHash, '$.snapshotHash');
  assertSnapshotSize(candidate);
  return candidate as unknown as PermutationBookSnapshot;
}

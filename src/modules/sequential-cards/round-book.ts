import { fail } from '../../api/errors.js';
import { ENGINE_LIMITS } from '../../api/limits.js';
import {
  CommandLedger,
  RECEIPT_WIRE_KEYS,
  assertIdempotencyKey,
  commandFingerprint,
  fromWireReceipt,
  toWireReceipt,
  type Receipt as LedgerReceipt,
  type StoredReceipt,
  type WireReceipt,
} from '../../core/ledger.js';
import { assertClaimBudget } from '../../core/module.js';
import { payableWithinCap, type Payable } from '../../core/payments.js';
import { constantTimeHexEqual, sealCommitment } from '../../core/commitment.js';
import { normalizeSeed } from '../../core/random.js';
import { equal as rationalEqual, rational, type Rational } from '../../core/rational.js';
import {
  assertSnapshotKeys,
  assertSnapshotRecord,
  assertSnapshotRevision,
  assertSnapshotSize,
  assertWireHex,
  assertWireString,
  fromWireRational,
  parseSnapshotJson,
  preflightSnapshotInput,
  parseWireBigInt,
  snapshotHash,
  toWireRational,
  type WireRational,
} from '../../core/snapshot.js';
import { assertIdentifier, isRecord } from '../../core/validation.js';
import { cardsFingerprint, cardsRoundOf } from './adapter.js';
import {
  CARDS_ACTIONS,
  CARDS_BOOK_SCHEMA,
  CARDS_SETTLEMENT_REASONS,
  type CardsAction,
  type CardsEarlySettlementReason,
  type CardsRejectionReason,
  type CardsSettlementReason,
  type PlayerChoice,
  type RevealStep,
  type SequentialCardsDefinition,
} from './contracts.js';
import {
  convertToCredits,
  deriveRoundingSeed,
  roundingCommitment,
  type CreditTape,
} from './credits.js';
import { cardsBelief, objectivePositionOf, objectiveRankOf, type CardsBelief } from './deck.js';
import { deriveDeal } from './truth.js';
import {
  coverProbability,
  entryClaim,
  fairValue,
  offeredActions,
  transformedClaim,
  type CardsOfferedAction,
} from './pricing.js';
import { deriveRevealSteps, encodeRevealStep, revealStepsEqual, stepDigest } from './steps.js';
import {
  cardsCommitmentBody,
  deserializeCardsTranscript,
  verifyCardsTranscript,
} from './transcript.js';
import { assertRevealSteps } from './record.js';
import { assertCardsDefinition, assertPlayerChoices, reject } from './validation.js';

export type CardsReceipt = LedgerReceipt<CardsAction>;

/** One row of the opening ticket. Every row carries its own stake. */
export type TicketSelection =
  | {
      readonly id: string;
      readonly kind: 'position';
      readonly position: number;
      readonly stake: bigint;
    }
  | {
      readonly id: string;
      readonly kind: 'market';
      readonly marketId: string;
      readonly stake: bigint;
    };

export interface OpenRequest {
  readonly idempotencyKey: string;
  readonly expectedStepRevision: number;
  /**
   * The round this ticket belongs to.
   *
   * It is bound into the open receipt and checked against the settlement proof.
   * Without it a book would accept any transcript whose reveals happen to match
   * its own — and two different rounds routinely publish the same reveal, since
   * a reveal discloses one rank and an order relation, not the hidden cards. The
   * proof would verify, and the round would settle on somebody else's deal.
   */
  readonly roundId: string;
  readonly seedCommitment: string;
  readonly clientSeed: string;
  readonly selections: readonly TicketSelection[];
  /**
   * The round's committed rounding tape, required exactly when
   * `pricing.rounding` is `'stochastic'` and refused otherwise.
   *
   * `deriveRoundingSeed(seed, fingerprint, roundId)` produces it from the sealed
   * round seed under a label disjoint from the deal and the selectors, so the
   * book can draw a settlement credit without ever holding the seed the reveals
   * come from. Its commitment is bound into the open receipt, and `settle`
   * re-derives it from the revealed seed and refuses a round whose credits came
   * from a different tape. It is a **round secret** until then: see `credits.ts`
   * for the one-credit edge a party who knows it early can take.
   */
  readonly roundingSeed?: string;
}

export interface PublishedCardsRound {
  readonly roundId: string;
  readonly seedCommitment: string;
}
export interface TransformRequest {
  readonly idempotencyKey: string;
  readonly expectedStepRevision: number;
  readonly selectionId: string;
  /** Target cover: exactly one position for a switch, at least two for a split. */
  readonly positions: readonly number[];
}
export interface RevealRequest {
  readonly idempotencyKey: string;
  readonly expectedStepRevision: number;
  readonly step: RevealStep;
}
export interface CashRequest {
  readonly idempotencyKey: string;
  readonly expectedStepRevision: number;
  readonly selectionId: string;
}
export interface SettleRequest {
  readonly idempotencyKey: string;
  readonly expectedStepRevision: number;
  readonly revealedSeed: string;
  readonly transcript: unknown;
}

/**
 * A settlement the **system** takes, not the player.
 *
 * The module owns no clock, so the host measures the window and says how long it
 * measured. That is the whole of the division of labour: the seconds are an
 * assertion the host makes and the module cannot check, and everything the
 * module *can* check — that the assertion clears the declared window, that an
 * early reason is one the definition declared, that the round is past its first
 * reveal, that the seed re-derives the round, and that the price is the one the
 * board was already showing — it checks and refuses.
 */
export interface DormantSettleRequest {
  readonly idempotencyKey: string;
  readonly expectedStepRevision: number;
  readonly revealedSeed: string;
  readonly transcript: unknown;
  /**
   * Seconds the host measured since the board became decidable. Compared
   * against `dormancy.windowSeconds`; ignored when an early reason is asserted,
   * because an early settlement is early by definition.
   */
  readonly elapsedSeconds: number;
  /**
   * A declared early-settlement reason, or absent for the ordinary
   * end-of-window case. Absent, the receipt records `ROUND_DORMANT`; present, it
   * records the reason in its own name, so the two are never conflated
   * afterwards.
   */
  readonly reason?: CardsEarlySettlementReason;
}

export type CardsSelectionStatus = 'live' | 'cashed' | 'settled';

/**
 * One priced selection inside a round.
 *
 * `claim` is the exact contingent payout, carried as a rational for the whole
 * round. A switch or a split rewrites it; nothing else does, and it becomes an
 * integer exactly once, at the one credit boundary this selection crosses.
 */
export interface CardsSelection {
  readonly id: string;
  readonly kind: 'position' | 'market';
  readonly marketId: string | null;
  /** The position this selection backed when the ticket opened; `null` for a market. */
  readonly openedPosition: number | null;
  /** Currently covered positions. Widens on a split, moves on a switch. */
  readonly positions: readonly number[];
  readonly stake: bigint;
  readonly claim: Rational;
  /** Step revision of the last in-round action; `-1` while none has been taken. */
  readonly decidedAtStepRevision: number;
  readonly status: CardsSelectionStatus;
  readonly credited: bigint;
}

/** A logged in-round claim transformation, in ledger order. */
export interface CardsDecision {
  readonly selectionId: string;
  readonly action: 'switch' | 'split';
  readonly stepRevision: number;
  readonly positions: readonly number[];
}

export interface CardsSettlementRecord {
  readonly revealedSeed: string;
  readonly commitment: string;
  readonly objectiveRank: number;
  readonly objectivePosition: number;
}

export interface WireCardsSelection {
  readonly id: string;
  readonly kind: string;
  readonly marketId: string | null;
  readonly openedPosition: number | null;
  readonly positions: readonly number[];
  readonly stake: string;
  readonly claim: WireRational;
  readonly decidedAtStepRevision: number;
  readonly status: string;
  readonly credited: string;
}

export interface CardsBookSnapshot {
  readonly schema: typeof CARDS_BOOK_SCHEMA;
  readonly definition: {
    readonly id: string;
    readonly version: string;
    readonly fingerprint: string;
  };
  readonly roundId: string | null;
  readonly seedCommitment: string | null;
  readonly clientSeed: string | null;
  readonly stepRevision: number;
  readonly ledgerRevision: number;
  readonly terminal: boolean;
  readonly choices: readonly {
    readonly index: number;
    readonly kind: string;
    readonly position: number;
  }[];
  readonly steps: readonly {
    readonly index: number;
    readonly position: number;
    readonly rank: number;
    readonly sorted: readonly number[];
    readonly label: string;
  }[];
  readonly selections: readonly WireCardsSelection[];
  readonly decisions: readonly {
    readonly selectionId: string;
    readonly action: string;
    readonly stepRevision: number;
    readonly positions: readonly number[];
  }[];
  readonly settlement: CardsSettlementRecord | null;
  /**
   * Why the system settled this round, or `null` when the player's own
   * settlement closed it.
   *
   * Present exactly when the definition declares a `dormancy` policy, on the
   * same rule as `roundingSeed`: a definition with no dormant path has nothing
   * to record and must not present a key the round would then have to decide
   * what to do with, and a snapshot of one that does is byte-identical to the
   * ones this module wrote before dormancy existed.
   */
  readonly settlementReason?: string | null;
  /**
   * The round's committed rounding tape.
   *
   * Present exactly when the definition declares `rounding: 'stochastic'`, and
   * `null` until the ticket that carries it is open. A `'floor'` snapshot has no
   * such key and is byte-identical to the ones this module wrote before the
   * settlement draw existed — the field is not optional decoration, it is a
   * function of the definition, and `snapshot.definition.fingerprint` pins which
   * one applies. It is a **round secret**, like the seed it derives from: a
   * snapshot store that leaks it hands out a bounded one-credit edge per credit
   * event, which is why §6.3's trusted-storage obligation covers it.
   */
  readonly roundingSeed?: string | null;
  readonly liquidBalance: string;
  readonly capBasisStake: string | null;
  readonly receipts: readonly { readonly fingerprint: string; readonly receipt: WireReceipt }[];
  readonly snapshotHash: string;
}

const SNAPSHOT_KEYS = Object.freeze([
  'schema',
  'definition',
  'roundId',
  'seedCommitment',
  'clientSeed',
  'stepRevision',
  'ledgerRevision',
  'terminal',
  'choices',
  'steps',
  'selections',
  'decisions',
  'settlement',
  'liquidBalance',
  'capBasisStake',
  'receipts',
  'snapshotHash',
]);

/**
 * The exact key set a snapshot of this definition must carry.
 *
 * A stochastic definition credits from a committed tape, so its snapshot carries
 * one; a deterministic one has nothing to carry and must not present a key the
 * round would then have to decide what to do with. Keying the shape off the
 * definition rather than off the payload is what keeps `assertSnapshotKeys`
 * exact in both directions — a `'floor'` snapshot with a `roundingSeed` is
 * refused, and so is a stochastic one without.
 */
function snapshotKeysFor(definition: SequentialCardsDefinition): readonly string[] {
  const keys = [...SNAPSHOT_KEYS];
  if (definition.pricing.rounding === 'stochastic') keys.push('roundingSeed');
  if (definition.dormancy !== undefined) keys.push('settlementReason');
  return keys.length === SNAPSHOT_KEYS.length ? SNAPSHOT_KEYS : Object.freeze(keys);
}

const SELECTION_KEYS = Object.freeze([
  'id',
  'kind',
  'marketId',
  'openedPosition',
  'positions',
  'stake',
  'claim',
  'decidedAtStepRevision',
  'status',
  'credited',
]);

/**
 * Multi-position round book.
 *
 * One round holds up to `maxOpenBeforeReveal` backed positions plus every side
 * market on the ticket, each independently funded, each independently
 * liquidatable at fair value, and each settled on its own outcome. There is
 * exactly **one ledger for the round** however many selections it holds: the
 * command serialization order and the dense ledger-revision chain the snapshot
 * format depends on cannot be forked per position.
 *
 * ## The credit boundary
 *
 * A switch and a split are **claim transformations, not money movements**. The
 * rational claim is recomputed exactly and never converted to credits, so a
 * selection crosses the credit boundary exactly once — at its cash-out or at
 * settlement. Both still mint a receipt with `debited: 0n, credited: 0n`, so the
 * ledger records the decision, the step revision it was taken at, and its
 * idempotency key. That is what makes a switch self-financing in the strongest
 * available sense: the new claim is financed entirely by the fair value of the
 * old one, and no rounding, cap arithmetic, or wallet movement happens in
 * between.
 *
 * ## The cap chain
 *
 * Every stake on the opening ticket is `external`, so the round's ceiling is
 * proportional to everything the player actually risked — a book holding three
 * independently funded selections has three times the ceiling of one holding
 * one. Every credit goes through `creditClaim`, which prices, mints, and applies
 * as a single call, so a repeated-credit shape like this one cannot half-perform
 * the cap chain.
 */
export class CardsBook {
  readonly #ledger: CommandLedger;
  readonly #selections = new Map<string, CardsSelection>();
  readonly #choices: PlayerChoice[] = [];
  /** Which entry of the choice log each backed selection owns. */
  readonly #choiceIndexOf = new Map<string, number>();
  readonly #steps: RevealStep[] = [];
  readonly #decisions: CardsDecision[] = [];
  #roundId: string | undefined;
  #seedCommitment: string | undefined;
  #clientSeed: string | undefined;
  #roundingSeed: string | undefined;
  #settlement: CardsSettlementRecord | null = null;
  #settlementReason: CardsSettlementReason | null = null;
  #terminal = false;

  constructor(readonly definition: SequentialCardsDefinition) {
    assertCardsDefinition(definition);
    this.#ledger = new CommandLedger({ maxWinMultiple: definition.risk.maxWinMultiple });
  }

  get selections(): readonly CardsSelection[] {
    return Object.freeze([...this.#selections.values()]);
  }
  get choices(): readonly PlayerChoice[] {
    return Object.freeze([...this.#choices]);
  }
  get steps(): readonly RevealStep[] {
    return Object.freeze([...this.#steps]);
  }
  get decisions(): readonly CardsDecision[] {
    return Object.freeze([...this.#decisions]);
  }
  get settlement(): CardsSettlementRecord | null {
    return this.#settlement;
  }
  /** `null` unless the system settled this round; never `null` after it did. */
  get settlementReason(): CardsSettlementReason | null {
    return this.#settlementReason;
  }
  get roundId(): string | undefined {
    return this.#roundId;
  }
  get publishedRound(): PublishedCardsRound | undefined {
    return this.#roundId === undefined || this.#seedCommitment === undefined
      ? undefined
      : Object.freeze({ roundId: this.#roundId, seedCommitment: this.#seedCommitment });
  }
  get stepRevision(): number {
    return this.#steps.length;
  }
  get ledgerRevision(): number {
    return this.#ledger.ledgerRevision;
  }
  get terminal(): boolean {
    return this.#terminal;
  }
  get liquidBalance(): bigint {
    return this.#ledger.liquidBalance;
  }
  get capBasisStake(): bigint | undefined {
    return this.#ledger.capBasisStake;
  }

  /**
   * The committed tape this round's settlement draws come from, if it has one.
   *
   * `undefined` under `rounding: 'floor'`, where the conversion is
   * deterministic and needs no draw at all.
   */
  #tape(): CreditTape | undefined {
    if (this.#roundingSeed === undefined || this.#roundId === undefined) return undefined;
    return Object.freeze({
      roundingSeed: this.#roundingSeed,
      round: cardsRoundOf(this.definition, this.#roundId),
    });
  }

  /** Exact belief after every reveal applied so far. */
  belief(): CardsBelief {
    return cardsBelief(this.definition, this.#steps);
  }

  /** Actions the definition offers for one live selection right now. */
  offers(selectionId: string): readonly CardsOfferedAction[] {
    const selection = this.#selections.get(selectionId);
    if (selection === undefined || selection.status !== 'live' || selection.kind !== 'position')
      return Object.freeze([]);
    if (selection.decidedAtStepRevision === this.stepRevision) return Object.freeze([]);
    return offeredActions(this.definition, this.belief(), selection.positions, {
      stepRevision: this.stepRevision,
      excluded: this.#coveredByOthers(selection.id),
    });
  }

  /**
   * Opens the round's one ticket.
   *
   * Every row is priced at `entryRtp / p` against the pre-reveal belief and
   * debited once; the backed rows are what the choice log records, and the log
   * has to be complete before the first reveal because the sealed selector
   * indexes an eligible set whose size was fixed against the declared backing
   * width.
   *
   * **Read once, then never again.** Every field of the request is copied into a
   * local before it is validated, and only the copies are priced, fingerprinted
   * and stored. `CommandLedger.execute` serializes commands behind an `await`,
   * so the body below runs on a later microtask than the validation above: a
   * caller that keeps a handle on its own request object — or hands over one
   * with an accessor — could otherwise have the round validate one stake and
   * debit, price and store another. `#assertTicketShape` returns rows this book
   * built, never the caller's.
   */
  async open(request: OpenRequest): Promise<CardsReceipt> {
    assertRequestRecord(request);
    const key = request.idempotencyKey;
    const expected = request.expectedStepRevision;
    const roundId = request.roundId;
    const publishedCommitment = request.seedCommitment;
    const clientSeed = request.clientSeed;
    assertIdempotencyKey(key);
    assertRevisionInput(expected);
    assertIdentifier(roundId, '$.roundId', 'CLAIM_REJECTED');
    if (typeof publishedCommitment !== 'string' || !/^[0-9a-f]{64}$/u.test(publishedCommitment))
      fail('COMMITMENT_MISMATCH', 'A seed commitment must be published before the ticket opens');
    if (
      typeof clientSeed !== 'string' ||
      !/^[0-9a-f]*$/iu.test(clientSeed) ||
      clientSeed.length % 2 !== 0 ||
      clientSeed.length / 2 > 128 ||
      (this.definition.seed.clientEntropy === 'required' &&
        clientSeed.length / 2 < this.definition.seed.clientSeedBytes)
    )
      reject(
        'CLAIM_REJECTED',
        'This definition requires bounded client entropy at admission',
        '$.clientSeed',
        'MISSING_CLIENT_ENTROPY',
      );
    const rows = this.#assertTicketShape(request.selections);
    // Read once, like every other field of the request, and required exactly
    // where the declared economics need it. A stochastic definition without a
    // tape is refused rather than credited under the other rule: both rules are
    // inside the definition fingerprint and they pay differently.
    const declaredSeed: unknown = request.roundingSeed;
    const stochastic = this.definition.pricing.rounding === 'stochastic';
    if (!stochastic && declaredSeed !== undefined)
      fail(
        'CLAIM_REJECTED',
        'This definition credits deterministically and takes no rounding tape',
        '$.roundingSeed',
        { reason: 'INVALID_ROUNDING_POLICY' },
      );
    if (stochastic && typeof declaredSeed !== 'string')
      fail(
        'CLAIM_REJECTED',
        'This definition credits with the settlement draw and needs its committed tape',
        '$.roundingSeed',
        { reason: 'INVALID_ROUNDING_POLICY' },
      );
    const roundingSeed = stochastic ? normalizeSeed(declaredSeed as string) : undefined;
    const fingerprint = openFingerprint(
      roundId,
      rows,
      roundingSeed === undefined ? undefined : roundingCommitment(roundingSeed),
      publishedCommitment,
      clientSeed,
    );
    return this.#ledger.execute<CardsAction>(key, fingerprint, () => {
      this.#assertStepRevision(expected);
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is terminal');
      if (this.#selections.size > 0)
        reject(
          'CLAIM_REJECTED',
          'This round already has a ticket',
          '$.selections',
          'ROUND_ALREADY_OPEN',
        );
      if (this.stepRevision !== 0)
        reject(
          'CLAIM_REJECTED',
          'A ticket must be opened before the first reveal',
          '$.expectedStepRevision',
          'ROUND_ALREADY_OPEN',
        );
      const belief = cardsBelief(this.definition, []);
      const budget =
        this.definition.backing.maxOpenBeforeReveal + this.definition.sideMarkets.length;
      let total = 0n;
      const priced: CardsSelection[] = [];
      rows.forEach((row, index) => {
        assertClaimBudget(index, budget, '$.selections');
        const probability =
          row.kind === 'position'
            ? coverProbability(belief, [row.position])
            : marketProbability(this.definition, belief, row.marketId);
        if (probability.numerator === 0n)
          reject(
            'CLAIM_REJECTED',
            'Cannot open a selection whose probability is exactly zero',
            `$.selections[${index}]`,
            'UNPRICEABLE_OUTCOME',
          );
        total += row.stake;
        priced.push(
          Object.freeze({
            id: row.id,
            kind: row.kind,
            marketId: row.kind === 'market' ? row.marketId : null,
            openedPosition: row.kind === 'position' ? row.position : null,
            positions: Object.freeze(row.kind === 'position' ? [row.position] : []),
            stake: row.stake,
            claim: entryClaim(this.definition, row.stake, probability),
            decidedAtStepRevision: -1,
            status: 'live',
            credited: 0n,
          }),
        );
      });
      const receipt = this.#mint(key, fingerprint, 'open', total, 0n, false);
      // Every row is fresh money from the wallet, so the round's ceiling is a
      // multiple of the whole ticket rather than of whichever row came first.
      this.#ledger.fundStake(total, 'external');
      this.#roundId = roundId;
      this.#seedCommitment = publishedCommitment;
      this.#clientSeed = clientSeed;
      this.#roundingSeed = roundingSeed;
      for (const selection of priced) this.#selections.set(selection.id, selection);
      for (const selection of priced)
        if (selection.kind === 'position') {
          this.#choiceIndexOf.set(selection.id, this.#choices.length);
          this.#choices.push(
            Object.freeze({
              index: this.#choices.length,
              kind: 'back',
              position: selection.openedPosition as number,
            }),
          );
        }
      return receipt;
    });
  }

  /**
   * Applies the next reveal the module derived from the sealed deal and the log.
   *
   * A reveal moves no money and is still a **ledger command**, minted with a
   * fingerprint over the reveal itself and the digest of everything published
   * before it. Without that, a reconnect snapshot taken between a reveal and the
   * player's decision would carry a reveal log that nothing had signed: every
   * receipt would still look canonical while the board said something the round
   * never showed. Fencing it also makes a duplicated reveal an idempotent replay
   * rather than a second card turning over.
   *
   * The step is **copied field by field before it is fingerprinted**, and only
   * the copy is validated, digested and pushed. Fingerprinting the caller's
   * object and then storing it after the ledger's `await` would reopen exactly
   * the hole this command was introduced to close, from inside the book: the
   * receipt would seal one card and the board would show another.
   */
  async advanceReveal(request: RevealRequest): Promise<CardsReceipt> {
    assertRequestRecord(request);
    const key = request.idempotencyKey;
    const expected = request.expectedStepRevision;
    assertIdempotencyKey(key);
    assertRevisionInput(expected);
    const step = this.#copyRevealStep(request.step);
    const fingerprint = commandFingerprint('reveal', [
      ...this.#bindingFields(),
      stepDigest(this.#steps),
      ...encodeRevealStep(step),
    ]);
    return this.#ledger.execute<CardsAction>(key, fingerprint, () => {
      this.#assertStepRevision(expected);
      if (this.#terminal) fail('ROUND_TERMINAL', 'Cannot advance a terminal round');
      if (this.#selections.size === 0)
        reject(
          'CLAIM_REJECTED',
          'A reveal needs a logged backing, so the ticket must be open first',
          '$.step',
          'ROUND_NOT_OPEN',
        );
      if (this.stepRevision >= this.definition.reveal.count)
        reject(
          'CLAIM_REJECTED',
          'The reveal schedule is already complete',
          '$.step',
          'CHOICE_CONFLICT',
        );
      assertRevealSteps(this.definition, this.#choices, [...this.#steps, step]);
      const receipt = this.#mint(key, fingerprint, 'reveal', 0n, 0n, false);
      this.#steps.push(step);
      return receipt;
    });
  }

  /**
   * A private, frozen copy of one reveal step, taken before anything reads it.
   *
   * Only the shape needed to make the copy safe is checked here — the value
   * rules are `assertRevealSteps`' job, inside the command. The width bound is
   * not decoration: `sorted` is attacker-supplied and is about to be copied, so
   * it is refused before an allocation is made from a length nobody checked.
   */
  #copyRevealStep(value: unknown): RevealStep {
    if (!isRecord(value)) fail('INVALID_TRANSCRIPT', 'Reveal must be an object', '$.step');
    const sorted: unknown = value.sorted;
    if (!Array.isArray(sorted))
      fail('INVALID_TRANSCRIPT', 'Reveal sort must be an array', '$.step.sorted');
    if (sorted.length > this.definition.ladder.dealt)
      fail('INVALID_TRANSCRIPT', 'Reveal sort is wider than the hand', '$.step.sorted');
    const copy: number[] = [];
    for (let index = 0; index < sorted.length; index += 1) copy.push(sorted[index] as number);
    return Object.freeze({
      index: value.index as number,
      position: value.position as number,
      rank: value.rank as number,
      sorted: Object.freeze(copy),
      label: value.label as string,
    });
  }

  /** Moves a live claim onto exactly one other position at true odds. */
  async switchClaim(request: TransformRequest): Promise<CardsReceipt> {
    return this.#transform('switch', request);
  }

  /** Hedges a live claim evenly across a set of positions at true odds. */
  async splitClaim(request: TransformRequest): Promise<CardsReceipt> {
    return this.#transform('split', request);
  }

  /** Liquidates one selection at fair value. Other selections are untouched. */
  async cash(request: CashRequest): Promise<CardsReceipt> {
    assertRequestRecord(request);
    const key = request.idempotencyKey;
    const expected = request.expectedStepRevision;
    const selectionId = request.selectionId;
    assertIdempotencyKey(key);
    assertRevisionInput(expected);
    assertIdentifier(selectionId, '$.selectionId', 'CLAIM_REJECTED');
    const fingerprint = commandFingerprint('cash', [
      ...this.#bindingFields(),
      stepDigest(this.#steps),
      selectionId,
    ]);
    return this.#ledger.execute<CardsAction>(key, fingerprint, () => {
      this.#assertStepRevision(expected);
      const selection = this.#assertActionable(selectionId, 'cash');
      const belief = this.belief();
      const value = fairValue(
        this.definition,
        selection.claim,
        coverProbability(belief, selection.positions),
      );
      // The one place a rational becomes an integer for this selection. The
      // conversion is handed the exact claim and the event that identifies it,
      // and what goes to the cap chain is the whole number it produced — so
      // `payableWithinCap` only ever caps, and the rounding rule is applied
      // exactly once, here, under the policy the definition declared.
      const credits = convertToCredits(
        this.definition,
        value,
        { selectionId: selection.id, sequence: this.#ledger.ledgerRevision + 1 },
        this.#tape(),
      ).credits;
      return this.#ledger.creditClaim(rational(credits), (payable) => {
        const receipt = this.#mint(key, fingerprint, 'cash', 0n, payable.credited, payable.capped);
        this.#selections.set(
          selection.id,
          Object.freeze({
            ...selection,
            status: 'cashed',
            credited: payable.credited,
            decidedAtStepRevision: this.stepRevision,
          }),
        );
        return receipt;
      });
    });
  }

  /**
   * Settles every selection still live against the revealed proof.
   *
   * The transcript must be *this* round's: the same choice log and the same
   * reveals. A settlement proof for a different decision sequence verifies on
   * its own and is still refused here, because it is not what this book played.
   */
  async settle(request: SettleRequest): Promise<CardsReceipt> {
    assertRequestRecord(request);
    const key = request.idempotencyKey;
    const expected = request.expectedStepRevision;
    assertIdempotencyKey(key);
    assertRevisionInput(expected);
    const revealedSeed = normalizeSeed(request.revealedSeed);
    const transcript = deserializeCardsTranscript(request.transcript);
    const objectiveRank = objectiveRankOf(this.definition, transcript.deal.ranks);
    const objectivePosition = objectivePositionOf(this.definition, transcript.deal.ranks);
    const fingerprint = commandFingerprint('settle', [
      ...this.#bindingFields(),
      stepDigest(this.#steps),
      revealedSeed,
      transcript.commitment,
      objectiveRank,
      objectivePosition,
    ]);
    return this.#ledger.execute<CardsAction>(key, fingerprint, () => {
      this.#assertStepRevision(expected);
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is already terminal');
      if (this.stepRevision !== this.definition.reveal.count)
        reject(
          'CLAIM_REJECTED',
          'Settlement requires the complete reveal schedule',
          '$.expectedStepRevision',
          'CHOICE_CONFLICT',
        );
      if (
        transcript.roundId !== this.#roundId ||
        transcript.seedCommitment !== this.#seedCommitment
      )
        fail(
          'COMMITMENT_MISMATCH',
          'Settlement proof does not open the published round binding',
          '$.seedCommitment',
        );
      const verification = verifyCardsTranscript(revealedSeed, this.definition, transcript);
      if (!verification.ok)
        fail('INVALID_TRANSCRIPT', verification.message, verification.path, {
          verificationCode: verification.code,
        });
      if (
        transcript.choices.length !== this.#choices.length ||
        transcript.choices.some(
          (choice, index) => choice.position !== this.#choices[index]?.position,
        ) ||
        !revealStepsEqual(transcript.steps, this.#steps)
      )
        fail('TRANSCRIPT_MISMATCH', 'Settlement proof is for a different round', '$.choices');
      // The revealed seed is public at this point, so the tape a mid-round
      // cash-out was credited from is finally checkable: it must be the one the
      // sealed seed produces. A round whose credits came from another tape is
      // refused here, which is the same shape of boundary as the reveal in §6.2
      // — validated during the round, authenticated at settlement.
      if (this.#roundingSeed !== undefined) {
        const expectedTape = deriveRoundingSeed(
          revealedSeed,
          cardsFingerprint(this.definition),
          this.#roundId as string,
        );
        if (!constantTimeHexEqual(expectedTape, this.#roundingSeed))
          fail(
            'TRANSCRIPT_MISMATCH',
            'The rounding tape this round credited from does not derive from the revealed seed',
            '$.revealedSeed',
          );
      }
      const total = settlementTotal(
        this.definition,
        this.selections,
        objectivePosition,
        objectiveRank,
        { tape: this.#tape(), sequence: this.#ledger.ledgerRevision + 1 },
      );
      const close = (payable: Payable): CardsReceipt => {
        const receipt = this.#mint(
          key,
          fingerprint,
          'settle',
          0n,
          payable.credited,
          payable.capped,
        );
        for (const selection of this.selections)
          if (selection.status === 'live')
            this.#selections.set(selection.id, Object.freeze({ ...selection, status: 'settled' }));
        this.#settlement = Object.freeze({
          revealedSeed,
          commitment: transcript.commitment,
          objectiveRank,
          objectivePosition,
        });
        this.#terminal = true;
        return receipt;
      };
      // A round that took no stake has no ceiling to measure a credit against.
      return this.#ledger.capBasisStake === undefined
        ? close(Object.freeze({ theoretical: total, credited: 0n, capped: false }))
        : this.#ledger.creditClaim(total, close);
    });
  }

  /**
   * Settles a round the player never came back to, at the price the board was
   * already showing.
   *
   * Every live **position** is liquidated at `p · claim` against the belief at
   * the round's current frame — the same number `cash` would have credited in
   * that state, and the reason `onDormant: 'cash'` is the only implemented
   * resolution: at a zero spread it is exactly EV-neutral, so a settlement
   * nobody chose neither guesses at intent nor imposes a loss. Every live
   * **market** settles from the deal, like any other settlement, because a
   * market has no in-round price to liquidate at. The seed is revealed on the
   * same command, so the round's commitment becomes checkable on schedule rather
   * than whenever a player happens to return.
   *
   * **This does not give the module a clock.** `elapsedSeconds` is the host's
   * measurement and the module cannot verify it; what the module does is refuse
   * everything around it — a window that has not elapsed, an early reason the
   * definition never declared, a round still before its first reveal, a seed
   * that does not re-derive the round, a tape the credits did not come from —
   * and record which reason was given, in the receipt fingerprint and in the
   * snapshot, so an auto-settlement can never be replayed as a player's
   * decision. A host that asserts a window it did not measure is inside the same
   * trust boundary as one that never calls this at all: §6.3 and
   * `docs/integration-checklist.md` state it as an obligation rather than imply
   * it is closed.
   */
  async settleDormant(request: DormantSettleRequest): Promise<CardsReceipt> {
    assertRequestRecord(request);
    const key = request.idempotencyKey;
    const expected = request.expectedStepRevision;
    const elapsed: unknown = request.elapsedSeconds;
    const declaredReason: unknown = request.reason;
    assertIdempotencyKey(key);
    assertRevisionInput(expected);
    const dormancy = this.definition.dormancy;
    if (dormancy === undefined)
      reject(
        'CLAIM_REJECTED',
        'This definition declares no dormancy policy, so no round of it is ever dormant',
        '$.dormancy',
        'ROUND_NOT_DORMANT',
      );
    if (!Number.isSafeInteger(elapsed) || (elapsed as number) < 0)
      reject(
        'CLAIM_REJECTED',
        'Elapsed seconds must be a non-negative safe integer',
        '$.elapsedSeconds',
        'ROUND_NOT_DORMANT',
      );
    let reason: CardsSettlementReason = 'ROUND_DORMANT';
    if (declaredReason !== undefined) {
      if (
        typeof declaredReason !== 'string' ||
        !(dormancy.earlySettlementReasons as readonly string[]).includes(declaredReason)
      )
        reject(
          'CLAIM_REJECTED',
          'That early-settlement reason is not one this definition declares',
          '$.reason',
          'INVALID_SETTLEMENT_REASON',
        );
      reason = 'ACCOUNT_STATE_CHANGED';
    } else if ((elapsed as number) < dormancy.windowSeconds)
      reject(
        'CLAIM_REJECTED',
        `The dormancy window is ${dormancy.windowSeconds} seconds and ${String(elapsed)} were asserted, with no early-settlement reason`,
        '$.elapsedSeconds',
        'ROUND_NOT_DORMANT',
      );
    const revealedSeed = normalizeSeed(request.revealedSeed);
    const transcript = deserializeCardsTranscript(request.transcript);
    const objectiveRank = objectiveRankOf(this.definition, transcript.deal.ranks);
    const objectivePosition = objectivePositionOf(this.definition, transcript.deal.ranks);
    const fingerprint = dormantFingerprint(
      stepDigest(this.#steps),
      {
        revealedSeed,
        commitment: transcript.commitment,
        objectiveRank,
        objectivePosition,
        reason,
      },
      { roundId: this.#roundId as string, seedCommitment: this.#seedCommitment as string },
    );
    return this.#ledger.execute<CardsAction>(key, fingerprint, () => {
      this.#assertStepRevision(expected);
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is already terminal');
      // The window runs from the moment the board became decidable, and before
      // the first reveal it never did: the prior is uniform, no liquidating
      // action is offered, and there is no price for a system settlement to be
      // "the one already showing". `triad/docs/DESIGN.md` §10.6 rule 7 makes the
      // same point from the product side.
      if (this.stepRevision < 1)
        reject(
          'CLAIM_REJECTED',
          'A round settles dormant only after the board became decidable, which is its first reveal',
          '$.expectedStepRevision',
          'ROUND_NOT_DORMANT',
        );
      if (
        transcript.roundId !== this.#roundId ||
        transcript.seedCommitment !== this.#seedCommitment
      )
        fail(
          'COMMITMENT_MISMATCH',
          'Settlement proof does not open the published round binding',
          '$.seedCommitment',
        );
      const verification = verifyCardsTranscript(revealedSeed, this.definition, transcript);
      if (!verification.ok)
        fail('INVALID_TRANSCRIPT', verification.message, verification.path, {
          verificationCode: verification.code,
        });
      // A dormant round may be settled part-way through its reveal schedule, so
      // the proof's steps have to *extend* this book's rather than equal them.
      // The prefix is still exact: every step this round published must be the
      // step the sealed deal produces at that index.
      if (
        transcript.choices.length !== this.#choices.length ||
        transcript.choices.some(
          (choice, index) => choice.position !== this.#choices[index]?.position,
        ) ||
        !revealStepsEqual(transcript.steps.slice(0, this.stepRevision), this.#steps)
      )
        fail('TRANSCRIPT_MISMATCH', 'Settlement proof is for a different round', '$.choices');
      if (this.#roundingSeed !== undefined) {
        const expectedTape = deriveRoundingSeed(
          revealedSeed,
          cardsFingerprint(this.definition),
          this.#roundId as string,
        );
        if (!constantTimeHexEqual(expectedTape, this.#roundingSeed))
          fail(
            'TRANSCRIPT_MISMATCH',
            'The rounding tape this round credited from does not derive from the revealed seed',
            '$.revealedSeed',
          );
      }
      const total = dormantTotal(this.definition, this.selections, this.belief(), objectiveRank, {
        tape: this.#tape(),
        sequence: this.#ledger.ledgerRevision + 1,
      });
      const close = (payable: Payable): CardsReceipt => {
        const receipt = this.#mint(
          key,
          fingerprint,
          'settleDormant',
          0n,
          payable.credited,
          payable.capped,
        );
        for (const selection of this.selections)
          if (selection.status === 'live')
            this.#selections.set(selection.id, Object.freeze({ ...selection, status: 'settled' }));
        this.#settlement = Object.freeze({
          revealedSeed,
          commitment: transcript.commitment,
          objectiveRank,
          objectivePosition,
        });
        this.#settlementReason = reason;
        this.#terminal = true;
        return receipt;
      };
      return this.#ledger.capBasisStake === undefined
        ? close(Object.freeze({ theoretical: total, credited: 0n, capped: false }))
        : this.#ledger.creditClaim(total, close);
    });
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }

  snapshot(): CardsBookSnapshot {
    const capBasisStake = this.#ledger.capBasisStake;
    const base = {
      schema: CARDS_BOOK_SCHEMA,
      definition: Object.freeze({
        id: this.definition.id,
        version: this.definition.version,
        fingerprint: cardsFingerprint(this.definition),
      }),
      roundId: this.#roundId ?? null,
      seedCommitment: this.#seedCommitment ?? null,
      clientSeed: this.#clientSeed ?? null,
      stepRevision: this.stepRevision,
      ledgerRevision: this.#ledger.ledgerRevision,
      terminal: this.#terminal,
      choices: Object.freeze(this.#choices.map((choice) => Object.freeze({ ...choice }))),
      steps: Object.freeze(
        this.#steps.map((step) =>
          Object.freeze({ ...step, sorted: Object.freeze([...step.sorted]) }),
        ),
      ),
      selections: Object.freeze(
        this.selections.map((selection) =>
          Object.freeze({
            id: selection.id,
            kind: selection.kind,
            marketId: selection.marketId,
            openedPosition: selection.openedPosition,
            positions: Object.freeze([...selection.positions]),
            stake: String(selection.stake),
            claim: toWireRational(selection.claim),
            decidedAtStepRevision: selection.decidedAtStepRevision,
            status: selection.status,
            credited: String(selection.credited),
          }),
        ),
      ),
      decisions: Object.freeze(
        this.#decisions.map((decision) =>
          Object.freeze({ ...decision, positions: Object.freeze([...decision.positions]) }),
        ),
      ),
      settlement: this.#settlement === null ? null : Object.freeze({ ...this.#settlement }),
      ...(this.definition.dormancy === undefined
        ? {}
        : { settlementReason: this.#settlementReason }),
      ...(this.definition.pricing.rounding === 'stochastic'
        ? { roundingSeed: this.#roundingSeed ?? null }
        : {}),
      liquidBalance: String(this.#ledger.liquidBalance),
      capBasisStake: capBasisStake === undefined ? null : String(capBasisStake),
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
   * Rebuilds a round from a reconnect snapshot by **re-deriving it**, not by
   * reading it.
   *
   * Nothing money-bearing is taken from the snapshot. Every selection's claim is
   * recomputed from the entry price at the pre-reveal belief and then replayed
   * through the transformation log, every credited integer is recomputed against
   * the cap chain as it stood at that receipt, the choice log is rebuilt from the
   * ticket and the transforms, and each command's fingerprint is recomputed —
   * over a digest of the reveals it was fenced to — and compared. Once a round
   * has settled, its revealed seed is public, so the deal, the reveals, the
   * objective, and the sealed commitment are re-derived from it as well.
   *
   * It also replays the round's **own rules**, command by command, because the
   * receipt algebra cannot see them: a command the round would have refused is
   * neither an inconsistency nor the stake. Every restored `switch`, `split` and
   * `cash` clears the guards its live counterpart clears, and every receipt is
   * held to the frame the round was actually standing at — the number of reveals
   * already installed — because a claim grown at one belief and priced at
   * another is the one rewrite that creates value out of an otherwise honest
   * log.
   *
   * **What that does and does not establish, precisely.** It defeats every
   * *inconsistent* rewrite: a claim that does not match its price, a decision
   * that does not match its receipt, a reveal that does not match the digest it
   * was fenced to, a credit that does not match the cap chain, a choice log that
   * does not match the ticket, and — after settlement — any outcome that does not
   * match the revealed seed. It defeats every *illegal command*: one the round's
   * rules would have refused at the revision its receipt claims. It does **not**
   * authenticate the snapshot. Receipt fingerprints and the checksum are unkeyed
   * and deterministic, so anyone who can rewrite the store can rewrite a field
   * *and* its receipt *and* the hash together — and what survives that is only
   * what this method can re-derive or replay. Two inputs are neither: the stake,
   * which enters from the wallet with no anchor inside the round, and a reveal,
   * which a book holding no seed cannot place (§6.2). A coordinated rewrite of
   * either restores. Snapshot integrity is a deployment obligation — trusted
   * storage, or a MAC the host owns — and
   * `docs/modules/sequential-cards.md` §6.3 says so, including the claim an
   * earlier revision of this docstring made that the code did not support.
   */
  static restore(
    definition: SequentialCardsDefinition,
    input: string | object,
    expectedBinding: PublishedCardsRound | null,
  ): CardsBook;
  static restore(
    definition: SequentialCardsDefinition,
    input: string | object,
    expectedBinding?: PublishedCardsRound | null,
  ): CardsBook {
    assertCardsDefinition(definition);
    const raw = parseCardsSnapshot(definition, input);
    if (raw.snapshotHash !== snapshotHash({ ...raw, snapshotHash: undefined }))
      fail('INVALID_SNAPSHOT', 'Snapshot hash is invalid', '$.snapshotHash');
    if (
      raw.definition.id !== definition.id ||
      raw.definition.version !== definition.version ||
      raw.definition.fingerprint !== cardsFingerprint(definition)
    )
      fail('DEFINITION_MISMATCH', 'Snapshot belongs to another definition', '$.definition');
    const bound = raw.roundId !== null || raw.seedCommitment !== null;
    if (bound && (raw.roundId === null || raw.seedCommitment === null))
      fail('INVALID_SNAPSHOT', 'Round binding is incomplete', '$.seedCommitment');
    if (expectedBinding === undefined)
      fail(
        'COMMITMENT_MISMATCH',
        'Restore requires the independently published round binding or explicit null',
        '$.expectedBinding',
      );
    if (
      (expectedBinding === null) !== !bound ||
      (expectedBinding !== null &&
        (raw.roundId !== expectedBinding.roundId ||
          raw.seedCommitment !== expectedBinding.seedCommitment))
    )
      fail(
        'COMMITMENT_MISMATCH',
        'Snapshot does not match the expected published round',
        '$.expectedBinding',
      );

    const book = new CardsBook(definition);
    if (raw.roundId !== null) assertIdentifier(raw.roundId, '$.roundId', 'INVALID_SNAPSHOT');
    book.#roundId = raw.roundId ?? undefined;
    book.#seedCommitment = raw.seedCommitment ?? undefined;
    book.#clientSeed = raw.clientSeed ?? undefined;
    assertPlayerChoices(definition, raw.choices, '$.choices');
    for (const choice of raw.choices) book.#choices.push(Object.freeze({ ...choice }));
    assertRevealSteps(definition, book.#choices, raw.steps, '$.steps');
    for (const step of raw.steps)
      book.#steps.push(Object.freeze({ ...step, sorted: Object.freeze([...step.sorted]) }));
    if (raw.stepRevision !== book.#steps.length)
      fail('INVALID_SNAPSHOT', 'Step revision does not match the reveal log', '$.stepRevision');
    book.#terminal = raw.terminal;
    // The tape is installed before the replay because every credited integer
    // below is re-derived through it. It is not money-bearing on its own — it
    // is the input the money is re-derived *from*, and the open receipt's
    // fingerprint is what stops a snapshot swapping it for one whose draws pay
    // better.
    book.#roundingSeed =
      typeof raw.roundingSeed === 'string' ? normalizeSeed(raw.roundingSeed) : undefined;

    const beliefAt = (revision: number): CardsBelief =>
      cardsBelief(definition, book.#steps.slice(0, revision));
    const prior = beliefAt(0);

    // Selections are rebuilt from their opening identity and re-priced; the
    // claim in the snapshot is a derived field and is only ever compared.
    const rows: TicketSelection[] = [];
    const derivedChoices: PlayerChoice[] = [];
    for (const [index, entry] of raw.selections.entries()) {
      const path = `$.selections[${index}]`;
      assertIdentifier(entry.id, `${path}.id`, 'INVALID_SNAPSHOT');
      const stake = parseWireBigInt(entry.stake, `${path}.stake`);
      if (stake <= 0n) fail('INVALID_SNAPSHOT', 'Stake must be positive', `${path}.stake`);
      if (entry.kind === 'position') {
        if (
          entry.marketId !== null ||
          typeof entry.openedPosition !== 'number' ||
          !Number.isSafeInteger(entry.openedPosition) ||
          entry.openedPosition < 0 ||
          entry.openedPosition >= definition.ladder.dealt
        )
          fail('INVALID_SNAPSHOT', 'Position selection is invalid', path);
        rows.push(
          Object.freeze({
            id: entry.id,
            kind: 'position' as const,
            position: entry.openedPosition,
            stake,
          }),
        );
      } else if (entry.kind === 'market') {
        if (entry.openedPosition !== null || typeof entry.marketId !== 'string')
          fail('INVALID_SNAPSHOT', 'Market selection is invalid', path);
        if (!definition.sideMarkets.some((market) => market.id === entry.marketId))
          fail('INVALID_SNAPSHOT', 'Unknown side market', `${path}.marketId`);
        rows.push(
          Object.freeze({
            id: entry.id,
            kind: 'market' as const,
            marketId: entry.marketId,
            stake,
          }),
        );
      } else fail('INVALID_SNAPSHOT', 'Unknown selection kind', `${path}.kind`);
    }
    // A restored ticket clears the same composition rules `open()` applies. A
    // snapshot describing a ticket the round would have refused — an
    // off-lattice stake, two rows on one position, a backing wider than the
    // declared width — is not a round this book ever played, however
    // self-consistent its receipts are.
    if (rows.length > 0)
      assertTicketComposition(definition, rows, (message, selectionPath) => {
        fail('INVALID_SNAPSHOT', message, selectionPath);
      });
    for (const row of rows) {
      const probability =
        row.kind === 'position'
          ? coverProbability(prior, [row.position])
          : marketProbability(definition, prior, row.marketId);
      if (row.kind === 'position') {
        book.#choiceIndexOf.set(row.id, derivedChoices.length);
        derivedChoices.push(
          Object.freeze({ index: derivedChoices.length, kind: 'back', position: row.position }),
        );
      }
      book.#selections.set(
        row.id,
        Object.freeze({
          id: row.id,
          kind: row.kind,
          marketId: row.kind === 'market' ? row.marketId : null,
          openedPosition: row.kind === 'position' ? row.position : null,
          positions: Object.freeze(row.kind === 'position' ? [row.position] : []),
          stake: row.stake,
          claim: entryClaim(definition, row.stake, probability),
          decidedAtStepRevision: -1,
          status: 'live',
          credited: 0n,
        }),
      );
    }
    if (book.#selections.size !== raw.selections.length)
      fail('INVALID_SNAPSHOT', 'Snapshot selection ids are not unique', '$.selections');

    let opened = false;
    let reveals = 0;
    let decisionIndex = 0;
    let liquid = 0n;
    let capBasis: bigint | undefined;
    let settled = false;
    const stored: StoredReceipt<CardsAction>[] = raw.receipts.map((entry) => ({
      fingerprint: entry.fingerprint,
      receipt: fromWireReceipt<CardsAction>(entry.receipt, CARDS_ACTIONS),
    }));
    book.#ledger.install(stored, book.stepRevision, (receipt) => {
      if (settled) fail('INVALID_SNAPSHOT', 'Receipts continue past settlement');
      // **The frame is not free.** A command is minted at the round's live step
      // revision, so a receipt's frame is exactly the number of reveals the log
      // has already installed — never an earlier one, and never a later one.
      // `CommandLedger.install` cannot know that: it only bounds the frame by
      // the reveal log's length, which leaves a snapshot free to price a
      // command at any belief the round ever held. That is the pairing that
      // creates value: a claim grown at a post-reveal belief, liquidated at the
      // pre-reveal one, is internally consistent receipt by receipt and is a
      // state no legal command sequence produces — so no walk this module
      // performs bounds it, `analyseDefinition`'s reachable maximum included.
      if (receipt.frameRevision !== reveals)
        fail(
          'INVALID_SNAPSHOT',
          'Receipt is fenced to a step revision the round was not standing at',
          '$.receipts',
        );
      const digest = stepDigest(book.#steps.slice(0, receipt.frameRevision));
      if (receipt.action === 'open') {
        if (opened || receipt.credited !== 0n)
          fail('INVALID_SNAPSHOT', 'Receipt sequence violates the round state machine');
        if (book.#roundId === undefined)
          fail(
            'INVALID_SNAPSHOT',
            'An opened round must name the round it belongs to',
            '$.roundId',
          );
        if ((definition.pricing.rounding === 'stochastic') !== (book.#roundingSeed !== undefined))
          fail(
            'INVALID_SNAPSHOT',
            'An open round credits from the tape its definition declares, or from none',
            '$.roundingSeed',
          );
        const expected = openFingerprint(
          book.#roundId,
          rows,
          book.#roundingSeed === undefined ? undefined : roundingCommitment(book.#roundingSeed),
          book.#seedCommitment as string,
          book.#clientSeed as string,
        );
        const total = rows.reduce((sum, row) => sum + row.stake, 0n);
        if (receipt.commandFingerprint !== expected || receipt.debited !== total)
          fail(
            'INVALID_SNAPSHOT',
            'Open receipt does not match the restored ticket',
            '$.selections',
          );
        capBasis = (capBasis ?? 0n) + total;
        opened = true;
        return;
      }
      if (!opened) fail('INVALID_SNAPSHOT', 'A round acts only after its ticket opened');
      if (receipt.action === 'reveal') {
        if (receipt.debited !== 0n || receipt.credited !== 0n)
          fail('INVALID_SNAPSHOT', 'A reveal must not move money');
        const step = book.#steps[receipt.frameRevision];
        if (
          step === undefined ||
          receipt.commandFingerprint !==
            commandFingerprint('reveal', [
              book.#roundId as string,
              book.#seedCommitment as string,
              digest,
              ...encodeRevealStep(step),
            ])
        )
          fail('INVALID_SNAPSHOT', 'Receipt does not match the reveal it recorded', '$.steps');
        reveals += 1;
        return;
      }
      if (receipt.action === 'switch' || receipt.action === 'split') {
        if (receipt.debited !== 0n || receipt.credited !== 0n)
          fail('INVALID_SNAPSHOT', 'A claim transformation must not move money');
        const decision = raw.decisions[decisionIndex];
        if (
          decision === undefined ||
          decision.action !== receipt.action ||
          decision.stepRevision !== receipt.frameRevision ||
          receipt.commandFingerprint !==
            commandFingerprint(receipt.action, [
              book.#roundId as string,
              book.#seedCommitment as string,
              digest,
              decision.selectionId,
              decision.positions.length,
              ...decision.positions,
            ])
        )
          fail('INVALID_SNAPSHOT', 'Receipt does not match the logged decision', '$.decisions');
        const selection = book.#selections.get(decision.selectionId);
        if (selection === undefined || selection.status !== 'live' || selection.kind !== 'position')
          fail(
            'INVALID_SNAPSHOT',
            'Decision targets a selection that cannot hold it',
            '$.decisions',
          );
        const belief = beliefAt(receipt.frameRevision);
        // Everything from here to the re-priced claim is the module's own state
        // machine, replayed rather than assumed. The receipt algebra above
        // proves the log is internally consistent; it does not prove the round
        // would have allowed the move, and a decision the rules would have
        // refused is neither an inconsistency nor the stake.
        assertRestoredCover(
          definition,
          receipt.action,
          decision.positions,
          `$.decisions[${decisionIndex}].positions`,
        );
        if (selection.decidedAtStepRevision === receipt.frameRevision)
          fail(
            'INVALID_SNAPSHOT',
            'Two decisions on one selection inside one decision window',
            `$.decisions[${decisionIndex}]`,
          );
        const excluded = book.#coveredByOthers(decision.selectionId);
        if (
          !offeredActions(definition, belief, selection.positions, {
            stepRevision: receipt.frameRevision,
            excluded,
          }).includes(receipt.action)
        )
          fail(
            'INVALID_SNAPSHOT',
            'The round did not offer that action in the state the receipt was minted in',
            `$.decisions[${decisionIndex}].action`,
          );
        for (const target of decision.positions) {
          if (!belief.record.hidden.includes(target))
            fail(
              'INVALID_SNAPSHOT',
              'A claim may only move onto a card that is still face down',
              `$.decisions[${decisionIndex}].positions`,
            );
          if ((belief.positionWeights[target] as bigint) === 0n)
            fail(
              'INVALID_SNAPSHOT',
              'A claim may not move onto an outcome of probability exactly zero',
              `$.decisions[${decisionIndex}].positions`,
            );
          if (receipt.frameRevision === 0 && excluded.has(target))
            fail(
              'INVALID_SNAPSHOT',
              'Another live selection already backs that position',
              `$.decisions[${decisionIndex}].positions`,
            );
        }
        book.#selections.set(
          selection.id,
          Object.freeze({
            ...selection,
            claim: transformedClaim(
              definition,
              selection.claim,
              coverProbability(belief, selection.positions),
              coverProbability(belief, decision.positions),
            ),
            positions: Object.freeze([...decision.positions]),
            decidedAtStepRevision: receipt.frameRevision,
          }),
        );
        book.#decisions.push(
          Object.freeze({
            selectionId: decision.selectionId,
            action: receipt.action,
            stepRevision: decision.stepRevision,
            positions: Object.freeze([...decision.positions]),
          }),
        );
        // A pre-reveal transform is a re-back, so the choice log the reveals
        // were derived against moves with it. The log is rebuilt from the
        // receipts rather than read out of the snapshot.
        const slot = book.#choiceIndexOf.get(decision.selectionId);
        if (receipt.frameRevision === 0 && slot !== undefined)
          derivedChoices[slot] = Object.freeze({
            index: slot,
            kind: 'back',
            position: decision.positions[0] as number,
          });
        decisionIndex += 1;
        return;
      }
      if (receipt.action === 'cash') {
        if (receipt.debited !== 0n)
          fail('INVALID_SNAPSHOT', 'A cash-out never debits', '$.receipts');
        const selection = [...book.#selections.values()].find(
          (candidate) =>
            candidate.status === 'live' &&
            receipt.commandFingerprint ===
              commandFingerprint('cash', [
                book.#roundId as string,
                book.#seedCommitment as string,
                digest,
                candidate.id,
              ]),
        );
        if (selection === undefined)
          fail('INVALID_SNAPSHOT', 'Cash receipt matches no live selection', '$.receipts');
        const belief = beliefAt(receipt.frameRevision);
        // The same replay the switch/split branch performs, and for the same
        // reason — except that this one carries money out of the round, so it
        // is the branch a forged receipt log is worth writing. `cash()` refuses
        // a side market, refuses a second decision inside one window, and
        // refuses an action the state did not offer; a restore that skipped any
        // of them would credit a liquidation the round would have rejected.
        if (selection.kind !== 'position')
          fail(
            'INVALID_SNAPSHOT',
            'A side market settles from the deal and has no in-round liquidation',
            '$.receipts',
          );
        if (selection.decidedAtStepRevision === receipt.frameRevision)
          fail(
            'INVALID_SNAPSHOT',
            'Two decisions on one selection inside one decision window',
            '$.receipts',
          );
        if (
          !offeredActions(definition, belief, selection.positions, {
            stepRevision: receipt.frameRevision,
            excluded: book.#coveredByOthers(selection.id),
          }).includes('cash')
        )
          fail(
            'INVALID_SNAPSHOT',
            'The round did not offer a cash-out in the state the receipt was minted in',
            '$.receipts',
          );
        const payable = payableWithinCap(
          rational(
            convertToCredits(
              definition,
              fairValue(definition, selection.claim, coverProbability(belief, selection.positions)),
              { selectionId: selection.id, sequence: receipt.ledgerRevision },
              book.#tape(),
            ).credits,
          ),
          capBasis as bigint,
          definition.risk.maxWinMultiple,
          liquid,
        );
        if (payable.credited !== receipt.credited || payable.capped !== receipt.capped)
          fail('INVALID_SNAPSHOT', 'Credited amount does not re-derive from the replayed price');
        liquid += receipt.credited;
        book.#selections.set(
          selection.id,
          Object.freeze({
            ...selection,
            status: 'cashed',
            credited: receipt.credited,
            decidedAtStepRevision: receipt.frameRevision,
          }),
        );
        return;
      }
      if (receipt.debited !== 0n)
        fail('INVALID_SNAPSHOT', 'A settlement never debits', '$.receipts');
      const record = raw.settlement;
      const dormant = receipt.action === 'settleDormant';
      const dormancy = definition.dormancy;
      // The reason is **re-derived through the fingerprint**, never read: the
      // expected fingerprint below is rebuilt from the reason the snapshot
      // carries, so relabelling an end-of-window settlement as an account-state
      // one — or the reverse — stops matching the receipt that recorded it.
      const reason = raw.settlementReason ?? null;
      if (dormant) {
        if (dormancy === undefined)
          fail(
            'INVALID_SNAPSHOT',
            'This definition declares no dormancy policy and its rounds have no system settlement',
            '$.receipts',
          );
        if (!(CARDS_SETTLEMENT_REASONS as readonly (string | null)[]).includes(reason))
          fail(
            'INVALID_SNAPSHOT',
            'A system settlement records the reason it was taken under',
            '$.settlementReason',
          );
        if (
          reason === 'ACCOUNT_STATE_CHANGED' &&
          !dormancy.earlySettlementReasons.includes('account-state-changed')
        )
          fail(
            'INVALID_SNAPSHOT',
            'That early-settlement reason is not one this definition declares',
            '$.settlementReason',
          );
        // Before the first reveal the board was never decidable, so there is no
        // price a dormant settlement could have been taken at.
        if (receipt.frameRevision < 1)
          fail(
            'INVALID_SNAPSHOT',
            'A dormant settlement cannot precede the reveal that made the board decidable',
            '$.receipts',
          );
      } else if (reason !== null)
        fail(
          'INVALID_SNAPSHOT',
          'A settlement the player took records no system reason',
          '$.settlementReason',
        );
      if (
        record === null ||
        (!dormant && receipt.frameRevision !== definition.reveal.count) ||
        receipt.commandFingerprint !==
          (dormant
            ? dormantFingerprint(
                digest,
                { ...record, reason: reason as string },
                {
                  roundId: book.#roundId as string,
                  seedCommitment: book.#seedCommitment as string,
                },
              )
            : commandFingerprint('settle', [
                book.#roundId as string,
                book.#seedCommitment as string,
                digest,
                record.revealedSeed,
                record.commitment,
                record.objectiveRank,
                record.objectivePosition,
              ]))
      )
        fail(
          'INVALID_SNAPSHOT',
          'Settle receipt does not match the settlement record',
          '$.settlement',
        );
      // The seed is public once a round has settled, so a settled snapshot is
      // re-**verified**, not merely re-derived: the deal comes back from the
      // revealed seed, the reveals from the deal and the choice log, and the
      // objective from the deal. Nothing about the outcome is read out of the
      // settlement record — the record is only ever compared against it, and a
      // forged outcome dies against the seed it claims to have come from.
      const round = cardsRoundOf(definition, book.#roundId as string);
      const deal = deriveDeal(record.revealedSeed, definition, round.roundId);
      const derivedSteps = deriveRevealSteps(definition, deal, book.#choices);
      // A dormant round may have been settled part-way through its schedule, so
      // its published reveals must be a **prefix** of what the seed produces.
      // The commitment below still re-seals over the whole derived list, which
      // is what the round committed to when it opened.
      if (!revealStepsEqual(derivedSteps.slice(0, book.#steps.length), book.#steps))
        fail(
          'INVALID_SNAPSHOT',
          'The reveal log does not re-derive from the revealed seed',
          '$.steps',
        );
      if (
        objectiveRankOf(definition, deal.ranks) !== record.objectiveRank ||
        objectivePositionOf(definition, deal.ranks) !== record.objectivePosition
      )
        fail(
          'INVALID_SNAPSHOT',
          'The settled outcome does not re-derive from the revealed seed',
          '$.settlement',
        );
      if (
        !constantTimeHexEqual(
          record.commitment,
          sealCommitment(
            record.revealedSeed,
            cardsCommitmentBody(definition, round, deal, derivedSteps, book.#choices),
          ),
        )
      )
        fail(
          'INVALID_SNAPSHOT',
          'The settled commitment does not re-seal from the revealed seed',
          '$.settlement',
        );
      if (book.#roundingSeed !== undefined) {
        const expectedTape = deriveRoundingSeed(
          record.revealedSeed,
          cardsFingerprint(definition),
          book.#roundId as string,
        );
        if (!constantTimeHexEqual(expectedTape, book.#roundingSeed))
          fail(
            'INVALID_SNAPSHOT',
            'The rounding tape does not re-derive from the revealed seed',
            '$.roundingSeed',
          );
      }
      const payable = payableWithinCap(
        dormant
          ? dormantTotal(
              definition,
              [...book.#selections.values()],
              beliefAt(receipt.frameRevision),
              record.objectiveRank,
              { tape: book.#tape(), sequence: receipt.ledgerRevision },
            )
          : settlementTotal(
              definition,
              [...book.#selections.values()],
              record.objectivePosition,
              record.objectiveRank,
              { tape: book.#tape(), sequence: receipt.ledgerRevision },
            ),
        capBasis as bigint,
        definition.risk.maxWinMultiple,
        liquid,
      );
      if (payable.credited !== receipt.credited || payable.capped !== receipt.capped)
        fail('INVALID_SNAPSHOT', 'Settled amount does not re-derive from the replayed claims');
      liquid += receipt.credited;
      for (const selection of [...book.#selections.values()])
        if (selection.status === 'live')
          book.#selections.set(selection.id, Object.freeze({ ...selection, status: 'settled' }));
      book.#settlement = Object.freeze({ ...record });
      book.#settlementReason = dormant ? (reason as CardsSettlementReason) : null;
      settled = true;
    });

    if (
      derivedChoices.length !== book.#choices.length ||
      derivedChoices.some((choice, index) => choice.position !== book.#choices[index]?.position)
    )
      fail(
        'INVALID_SNAPSHOT',
        'The choice log does not re-derive from the receipt log',
        '$.choices',
      );
    if (reveals !== book.#steps.length)
      fail('INVALID_SNAPSHOT', 'The reveal log has entries no receipt recorded', '$.steps');
    if (decisionIndex !== raw.decisions.length)
      fail('INVALID_SNAPSHOT', 'The decision log has entries no receipt recorded', '$.decisions');
    if (settled !== raw.terminal)
      fail('INVALID_SNAPSHOT', 'Terminal flag disagrees with the receipt log', '$.terminal');
    if ((raw.settlement === null) === settled)
      fail('INVALID_SNAPSHOT', 'Settlement record disagrees with the receipt log', '$.settlement');
    // A reason on a round the receipts never settled by the system is a field
    // nothing in the replay above would have looked at, so it is refused here
    // rather than carried into a restored book that would then publish it.
    if (
      definition.dormancy !== undefined &&
      (raw.settlementReason ?? null) !== book.#settlementReason
    )
      fail(
        'INVALID_SNAPSHOT',
        'Settlement reason disagrees with the receipt log',
        '$.settlementReason',
      );
    if (
      opened !==
      (book.#roundId !== undefined &&
        book.#seedCommitment !== undefined &&
        book.#clientSeed !== undefined)
    )
      fail('INVALID_SNAPSHOT', 'Round identity disagrees with the receipt log', '$.roundId');
    if (!opened && book.#roundingSeed !== undefined)
      fail(
        'INVALID_SNAPSHOT',
        'A round that never opened a ticket carries no rounding tape',
        '$.roundingSeed',
      );
    if (opened !== raw.selections.length > 0)
      fail(
        'INVALID_SNAPSHOT',
        'Selections exist without the ticket that opened them',
        '$.selections',
      );
    if (liquid !== parseWireBigInt(raw.liquidBalance, '$.liquidBalance', true))
      fail('INVALID_SNAPSHOT', 'Snapshot accounting does not conserve liquid value');
    const declaredBasis =
      raw.capBasisStake === null
        ? undefined
        : parseWireBigInt(raw.capBasisStake, '$.capBasisStake');
    if (declaredBasis !== capBasis)
      fail(
        'INVALID_SNAPSHOT',
        'Cap basis does not re-derive from the receipt log',
        '$.capBasisStake',
      );
    // Every derived field is now recomputed; the snapshot's own copies are only
    // ever compared against it.
    raw.selections.forEach((entry, index) => {
      const derived = book.#selections.get(entry.id);
      if (
        derived === undefined ||
        derived.status !== entry.status ||
        derived.decidedAtStepRevision !== entry.decidedAtStepRevision ||
        derived.credited !==
          parseWireBigInt(entry.credited, `$.selections[${index}].credited`, true) ||
        derived.positions.length !== entry.positions.length ||
        derived.positions.some((position, slot) => position !== entry.positions[slot]) ||
        !rationalEqual(derived.claim, fromWireRational(entry.claim, `$.selections[${index}].claim`))
      )
        fail(
          'INVALID_SNAPSHOT',
          'Selection state does not re-derive from the receipt log',
          `$.selections[${index}]`,
        );
    });
    book.#ledger.restoreBalances({
      ledgerRevision: raw.ledgerRevision,
      liquidBalance: liquid,
      capBasisStake: capBasis,
    });
    return book;
  }

  #coveredByOthers(selectionId: string): ReadonlySet<number> {
    const covered = new Set<number>();
    for (const selection of this.#selections.values())
      if (selection.id !== selectionId && selection.status === 'live')
        for (const position of selection.positions) covered.add(position);
    return covered;
  }

  #bindingFields(): readonly [string, string] {
    if (this.#roundId === undefined || this.#seedCommitment === undefined)
      fail('COMMITMENT_MISMATCH', 'A round binding must be published before play');
    return Object.freeze([this.#roundId, this.#seedCommitment]);
  }

  async #transform(action: 'switch' | 'split', request: TransformRequest): Promise<CardsReceipt> {
    assertRequestRecord(request);
    const key = request.idempotencyKey;
    const expected = request.expectedStepRevision;
    const selectionId = request.selectionId;
    assertIdempotencyKey(key);
    assertRevisionInput(expected);
    assertIdentifier(selectionId, '$.selectionId', 'CLAIM_REJECTED');
    const positions = assertTargetShape(this.definition, action, request.positions);
    const fingerprint = commandFingerprint(action, [
      ...this.#bindingFields(),
      stepDigest(this.#steps),
      selectionId,
      positions.length,
      ...positions,
    ]);
    return this.#ledger.execute<CardsAction>(key, fingerprint, () => {
      this.#assertStepRevision(expected);
      const selection = this.#assertActionable(selectionId, action);
      const belief = this.belief();
      const excluded = this.#coveredByOthers(selection.id);
      for (const target of positions) {
        if (!belief.record.hidden.includes(target))
          reject(
            'CLAIM_REJECTED',
            'A claim may only move onto a card that is still face down',
            '$.positions',
            'UNPRICEABLE_OUTCOME',
          );
        if ((belief.positionWeights[target] as bigint) === 0n)
          reject(
            'CLAIM_REJECTED',
            'That outcome has probability exactly zero and has no finite price',
            '$.positions',
            'UNPRICEABLE_OUTCOME',
          );
        if (this.stepRevision === 0 && excluded.has(target))
          reject(
            'CLAIM_REJECTED',
            'Another live selection already backs that position',
            '$.positions',
            'POSITION_ALREADY_BACKED',
          );
      }
      const from = coverProbability(belief, selection.positions);
      const to = coverProbability(belief, positions);
      const claim = transformedClaim(this.definition, selection.claim, from, to);
      const receipt = this.#mint(key, fingerprint, action, 0n, 0n, false);
      this.#selections.set(
        selection.id,
        Object.freeze({
          ...selection,
          positions: Object.freeze([...positions]),
          claim,
          decidedAtStepRevision: this.stepRevision,
        }),
      );
      this.#decisions.push(
        Object.freeze({
          selectionId: selection.id,
          action,
          stepRevision: this.stepRevision,
          positions: Object.freeze([...positions]),
        }),
      );
      // A pre-reveal switch is a re-back: it changes which card is backed, and
      // therefore which card the reveal may take. The log has to move with it,
      // and it is still before the first reveal, so the sealed selector still
      // indexes an eligible set of exactly the size it was sealed against.
      const slot = this.#choiceIndexOf.get(selection.id);
      if (this.stepRevision === 0 && slot !== undefined)
        this.#choices[slot] = Object.freeze({
          index: slot,
          kind: 'back',
          position: positions[0] as number,
        });
      return receipt;
    });
  }

  #assertActionable(selectionId: string, action: CardsOfferedAction): CardsSelection {
    if (this.#terminal) fail('ROUND_TERMINAL', 'Round is terminal');
    const selection = this.#selections.get(selectionId);
    if (selection === undefined)
      reject('CLAIM_REJECTED', 'Unknown selection', '$.selectionId', 'UNKNOWN_SELECTION');
    if (selection.status !== 'live')
      reject(
        'CLAIM_REJECTED',
        'Selection is no longer live',
        '$.selectionId',
        'SELECTION_NOT_LIVE',
      );
    if (selection.kind !== 'position')
      reject(
        'CLAIM_REJECTED',
        'A side market settles from the deal and has no in-round action',
        '$.selectionId',
        'ACTION_NOT_OFFERED',
      );
    if (selection.decidedAtStepRevision === this.stepRevision)
      reject(
        'CLAIM_REJECTED',
        'This selection has already acted in this decision window',
        '$.selectionId',
        'DECISION_ALREADY_TAKEN',
      );
    const offers = offeredActions(this.definition, this.belief(), selection.positions, {
      stepRevision: this.stepRevision,
      excluded: this.#coveredByOthers(selection.id),
    });
    if (offers.length === 0)
      reject(
        'CLAIM_REJECTED',
        'The reveal already settled this position, so no action is offered',
        '$.selectionId',
        'POSITION_SETTLED',
      );
    if (!offers.includes(action))
      reject(
        'CLAIM_REJECTED',
        `This definition does not offer ${action} here`,
        '$.selectionId',
        this.stepRevision === 0 && action === 'switch' ? 'REBACK_REJECTED' : 'ACTION_NOT_OFFERED',
      );
    return selection;
  }

  /**
   * Validates a caller's ticket and returns rows **this book built**.
   *
   * Every field is read exactly once, into a local, and the row that comes out
   * is a fresh frozen object assembled from those locals. Returning the caller's
   * objects — even inside a frozen array — would leave every later read of
   * `row.stake` at the mercy of whoever supplied it, and there are several of
   * them: the fingerprint, the debit total, the price, and the stored selection,
   * all of which run after `CommandLedger.execute` has awaited its turn.
   */
  #assertTicketShape(selections: unknown): readonly TicketSelection[] {
    if (!Array.isArray(selections))
      reject(
        'CLAIM_REJECTED',
        'A ticket needs at least one selection',
        '$.selections',
        'ROUND_NOT_OPEN',
      );
    // The length is read once and checked before a single row is read, so an
    // oversized ticket costs one comparison rather than a full validation pass
    // and every allocation that pass would make from attacker-supplied content.
    const width = selections.length;
    const budget = this.definition.backing.maxOpenBeforeReveal + this.definition.sideMarkets.length;
    if (width > budget)
      reject(
        'CLAIM_REJECTED',
        `A ticket may hold at most ${budget} selections`,
        '$.selections',
        'DUPLICATE_SELECTION',
      );
    const rows: TicketSelection[] = [];
    for (let index = 0; index < width; index += 1) {
      const path = `$.selections[${index}]`;
      const entry: unknown = selections[index];
      if (!isRecord(entry)) fail('CLAIM_REJECTED', 'Selection must be an object', path);
      const id: unknown = entry.id;
      const kind: unknown = entry.kind;
      const stake: unknown = entry.stake;
      assertIdentifier(id, `${path}.id`, 'CLAIM_REJECTED');
      if (typeof stake !== 'bigint' || stake <= 0n)
        reject(
          'CLAIM_REJECTED',
          'Stake must be a positive BigInt',
          `${path}.stake`,
          'STAKE_BELOW_MINIMUM',
        );
      if (kind === 'position') {
        const position: unknown = entry.position;
        if (
          !Number.isSafeInteger(position) ||
          (position as number) < 0 ||
          (position as number) >= this.definition.ladder.dealt
        )
          fail('UNKNOWN_OUTCOME', 'Backed position is out of range', `${path}.position`);
        rows.push(
          Object.freeze({ id, kind: 'position' as const, position: position as number, stake }),
        );
      } else if (kind === 'market') {
        const marketId: unknown = entry.marketId;
        if (
          typeof marketId !== 'string' ||
          !this.definition.sideMarkets.some((market) => market.id === marketId)
        )
          fail('UNKNOWN_OUTCOME', 'Unknown side market', `${path}.marketId`);
        rows.push(Object.freeze({ id, kind: 'market' as const, marketId, stake }));
      } else fail('CLAIM_REJECTED', 'Unknown selection kind', `${path}.kind`);
    }
    assertTicketComposition(this.definition, rows, (message, path, reason) => {
      reject('CLAIM_REJECTED', message, path, reason);
    });
    return Object.freeze(rows);
  }

  #assertStepRevision(expected: number): void {
    if (expected !== this.stepRevision)
      fail('STALE_FRAME', 'Expected step revision is stale', '$.expectedStepRevision', {
        expected: this.stepRevision,
        received: expected,
      });
  }

  #mint(
    key: string,
    fingerprint: string,
    action: CardsAction,
    debited: bigint,
    credited: bigint,
    capped: boolean,
  ): CardsReceipt {
    return this.#ledger.mint(
      key,
      fingerprint,
      action,
      this.stepRevision,
      debited,
      credited,
      capped,
    );
  }
}

/**
 * What a settlement owes, as an exact integer.
 *
 * `ticket.stakeScope` is `per-selection`, and this is where that has to be true
 * of the money and not only of the validation: each winning selection's claim is
 * floored **on its own** and the integers are summed. Adding the rationals first
 * and flooring once would let one selection's fractional part finance another's,
 * so a player settling two rows together could receive one credit more than the
 * same two rows cashed one at a time. The claim stays exact until its own credit
 * boundary and no further.
 */
export function settlementTotal(
  definition: SequentialCardsDefinition,
  selections: readonly CardsSelection[],
  objectivePosition: number,
  objectiveRank: number,
  event?: { readonly tape: CreditTape | undefined; readonly sequence: number },
): Rational {
  let credits = 0n;
  for (const selection of selections) {
    if (selection.status !== 'live') continue;
    const wins =
      selection.kind === 'position'
        ? selection.positions.includes(objectivePosition)
        : (definition.sideMarkets
            .find((market) => market.id === selection.marketId)
            ?.winningRanks.includes(objectiveRank) ?? false);
    if (!wins) continue;
    // Each row draws under its own selection id, so one settlement receipt
    // crediting several rows still gives each of them an independent draw —
    // and, as under `'floor'`, no row's remainder can finance another's.
    credits += convertToCredits(
      definition,
      selection.claim,
      { selectionId: selection.id, sequence: event?.sequence ?? 0 },
      event?.tape,
    ).credits;
  }
  return rational(credits);
}

/**
 * What a **dormant** settlement owes, as an exact integer.
 *
 * The two halves are priced from different things on purpose, and that is the
 * whole content of `onDormant: 'cash'`:
 *
 * - a live **position** is liquidated at `p · claim` against the belief at the
 *   frame the round was standing at, which is the number `cash` would have
 *   credited in that state and never more than the claim it liquidates;
 * - a live **market** settles from the objective rank, exactly as under
 *   `settle`, because a market carries no position to liquidate and no in-round
 *   price to do it at.
 *
 * Each row crosses its own credit boundary and its remainder finances nothing
 * else's, for the same reason `settlementTotal` floors row by row. And because
 * `p · claim ≤ claim` everywhere, a dormant settlement can never pay more than
 * the settlement it replaces — so the reachable maximum `defineCardsGame` proves
 * the cap against still bounds this path without a second walk.
 */
export function dormantTotal(
  definition: SequentialCardsDefinition,
  selections: readonly CardsSelection[],
  belief: CardsBelief,
  objectiveRank: number,
  event: { readonly tape: CreditTape | undefined; readonly sequence: number },
): Rational {
  let credits = 0n;
  for (const selection of selections) {
    if (selection.status !== 'live') continue;
    const claim =
      selection.kind === 'position'
        ? fairValue(definition, selection.claim, coverProbability(belief, selection.positions))
        : (
              definition.sideMarkets.find((market) => market.id === selection.marketId)
                ?.winningRanks ?? []
            ).includes(objectiveRank)
          ? selection.claim
          : rational(0n);
    if (claim.numerator === 0n) continue;
    credits += convertToCredits(
      definition,
      claim,
      { selectionId: selection.id, sequence: event.sequence },
      event.tape,
    ).credits;
  }
  return rational(credits);
}

/**
 * The command fingerprint of a dormant settlement.
 *
 * The **reason** is inside it, which is what stops the two system paths being
 * relabelled after the fact: a receipt minted for an end-of-window settlement
 * cannot be re-presented as an account-state one, or the other way round,
 * without the fingerprint stopping matching. `restore()` rebuilds it from the
 * reason the snapshot carries, so the field is re-derived rather than read.
 */
export function dormantFingerprint(
  digest: string,
  record: {
    readonly revealedSeed: string;
    readonly commitment: string;
    readonly objectiveRank: number;
    readonly objectivePosition: number;
    readonly reason: string;
  },
  binding?: PublishedCardsRound,
): string {
  return commandFingerprint('settleDormant', [
    ...(binding === undefined ? [] : [binding.roundId, binding.seedCommitment]),
    digest,
    record.revealedSeed,
    record.commitment,
    record.objectiveRank,
    record.objectivePosition,
    record.reason,
  ]);
}

function marketProbability(
  definition: SequentialCardsDefinition,
  belief: CardsBelief,
  marketId: string,
): Rational {
  const market = definition.sideMarkets.find((candidate) => candidate.id === marketId);
  if (market === undefined) fail('UNKNOWN_OUTCOME', 'Unknown side market', '$.marketId');
  let favourable = 0n;
  for (const rank of market.winningRanks) favourable += belief.rankWeights[rank] as bigint;
  return rational(favourable, belief.total);
}

/**
 * The cover a restored decision claims to have moved a claim onto.
 *
 * `decisions[].positions` is the one untrusted array whose rules belong to the
 * definition rather than to the snapshot format, so `parseCardsSnapshot` can
 * only bound it — and it flows straight into `coverProbability`, where an
 * out-of-range index reads `undefined` out of `belief.positionWeights` and
 * raises a raw `TypeError` instead of the typed `RevealEngineError` every
 * integration branches on. It is checked here in the canonical ascending form
 * the live path always produces, so a repeated or unsorted cover — which no
 * command could have written — is refused rather than priced.
 */
function assertRestoredCover(
  definition: SequentialCardsDefinition,
  action: 'switch' | 'split',
  positions: readonly number[],
  path: string,
): void {
  if (action === 'switch' ? positions.length !== 1 : positions.length < 2)
    fail('INVALID_SNAPSHOT', `A ${action} cover has the wrong width`, path);
  if (positions.length > definition.ladder.dealt)
    fail('INVALID_SNAPSHOT', 'A cover names more positions than the hand holds', path);
  positions.forEach((position, index) => {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= definition.ladder.dealt ||
      (index > 0 && position <= (positions[index - 1] as number))
    )
      fail('INVALID_SNAPSHOT', 'Cover positions must be sorted, unique, and inside the hand', path);
  });
}

/**
 * A refusal, so one rule set can serve two boundaries with two error codes.
 *
 * A caller's ticket is a `CLAIM_REJECTED`; the same rule broken by a reconnect
 * snapshot is an `INVALID_SNAPSHOT`, because `docs/api-contract.md` makes `code`
 * the thing a host branches on and those are different situations for it.
 */
type TicketRefusal = (message: string, path: string, reason: CardsRejectionReason) => never;

/**
 * The composition rules of a ticket, in exactly one place.
 *
 * `open()` and `restore()` both run them. A snapshot describing a ticket this
 * round's own rules would have refused is not a round this book ever played, and
 * `docs/lifecycle-modules.md` is normative that `restore()` replays the receipt
 * log **with the module's own state-machine rules** rather than with the receipt
 * algebra alone. Keeping one implementation is what stops the two from drifting
 * into a restore path that admits states no command sequence can reach.
 */
export function assertTicketComposition(
  definition: SequentialCardsDefinition,
  rows: readonly TicketSelection[],
  refuse: TicketRefusal,
): void {
  const budget = definition.backing.maxOpenBeforeReveal + definition.sideMarkets.length;
  if (rows.length === 0)
    refuse('A ticket needs at least one selection', '$.selections', 'ROUND_NOT_OPEN');
  if (rows.length > budget)
    refuse(`A ticket may hold at most ${budget} selections`, '$.selections', 'DUPLICATE_SELECTION');
  const ids = new Set<string>();
  const backed = new Set<number>();
  rows.forEach((row, index) => {
    const path = `$.selections[${index}]`;
    if (ids.has(row.id))
      refuse('Selection ids must be unique', `${path}.id`, 'DUPLICATE_SELECTION');
    ids.add(row.id);
    if (
      row.stake < definition.pricing.minStakeCredits ||
      row.stake % definition.pricing.stakeStepCredits !== 0n
    )
      refuse(
        `Every selection must stake at least ${definition.pricing.minStakeCredits} credits, on the ${definition.pricing.stakeStepCredits}-credit lattice`,
        `${path}.stake`,
        'STAKE_BELOW_MINIMUM',
      );
    if (row.kind !== 'position') return;
    if (backed.has(row.position))
      refuse(
        'A position may be backed by only one selection',
        `${path}.position`,
        'POSITION_ALREADY_BACKED',
      );
    backed.add(row.position);
    if (backed.size > definition.backing.maxOpenBeforeReveal)
      refuse(
        'More backed positions than the definition admits before a reveal',
        `${path}.position`,
        'POSITION_ALREADY_BACKED',
      );
  });
  // Under `unbacked` eligibility the sealed selector indexes a set sized
  // against the declared backing width, so the round is only derivable when
  // the log is exactly that wide.
  if (
    definition.reveal.eligibility === 'unbacked' &&
    backed.size !== definition.backing.maxOpenBeforeReveal
  )
    refuse(
      `This definition needs exactly ${definition.backing.maxOpenBeforeReveal} backed position(s) on the ticket`,
      '$.selections',
      'CHOICE_REQUIRED',
    );
  if (definition.ticket.requiresBackedMarket && backed.size === 0)
    refuse(
      'A ticket of side markets alone has no reveal to derive',
      '$.selections',
      'BACKED_SELECTION_REQUIRED',
    );
}

/**
 * The `open` command fingerprint: the round, every priced row, and — when the
 * definition credits with the settlement draw — the commitment to the tape those
 * credits will be drawn from.
 *
 * The commitment is appended rather than interleaved, and omitted entirely under
 * a deterministic rule, so a `'floor'` definition's fingerprints, receipts and
 * snapshots are byte-identical to the ones this module minted before the draw
 * existed. What it buys where it is present: a snapshot cannot swap the tape a
 * round's credits came from without the open receipt noticing.
 */
export function openFingerprint(
  roundId: string,
  rows: readonly TicketSelection[],
  tapeCommitment?: string,
  seedCommitment?: string,
  clientSeed?: string,
): string {
  return commandFingerprint('open', [
    stepDigest([]),
    roundId,
    ...(seedCommitment === undefined ? [] : [seedCommitment, clientSeed as string]),
    rows.length,
    ...rows.flatMap((row) => ticketRowFields(row)),
    ...(tapeCommitment === undefined ? [] : [tapeCommitment]),
  ]);
}

/** Canonical fields one ticket row contributes to the `open` command fingerprint. */
export function ticketRowFields(row: TicketSelection): (string | number | bigint)[] {
  return row.kind === 'position'
    ? [row.id, 'position', row.position, row.stake]
    : [row.id, 'market', row.marketId, row.stake];
}

function assertRequestRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail('CLAIM_REJECTED', 'Request must be an object');
}

function assertRevisionInput(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    fail('STALE_FRAME', 'Expected step revision is invalid', '$.expectedStepRevision');
}

/**
 * The target cover of a switch or a split, validated and normalised.
 *
 * The array is copied out by index before anything is checked, so what is
 * validated is what is fingerprinted and stored. The returned cover is sorted
 * ascending and duplicate-free, which is the canonical form every fingerprint,
 * every snapshot and every restore comparison is taken over.
 */
function assertTargetShape(
  definition: SequentialCardsDefinition,
  action: 'switch' | 'split',
  positions: unknown,
): readonly number[] {
  if (!Array.isArray(positions))
    fail('CLAIM_REJECTED', 'Target positions must be an array', '$.positions');
  const width = positions.length;
  if (action === 'switch' && width !== 1)
    reject(
      'CLAIM_REJECTED',
      'A switch names exactly one target',
      '$.positions',
      'ACTION_NOT_OFFERED',
    );
  if (action === 'split' && width < 2)
    reject(
      'CLAIM_REJECTED',
      'A split hedges at least two positions',
      '$.positions',
      'ACTION_NOT_OFFERED',
    );
  if (width > definition.ladder.dealt)
    reject(
      'CLAIM_REJECTED',
      'A cover cannot name more positions than the hand holds',
      '$.positions',
      'ACTION_NOT_OFFERED',
    );
  const cover: number[] = [];
  for (let index = 0; index < width; index += 1) {
    const position: unknown = positions[index];
    if (
      !Number.isSafeInteger(position) ||
      (position as number) < 0 ||
      (position as number) >= definition.ladder.dealt ||
      cover.includes(position as number)
    )
      fail('UNKNOWN_OUTCOME', 'Target position is out of range or repeats', '$.positions');
    cover.push(position as number);
  }
  return Object.freeze(cover.sort((left, right) => left - right));
}

function parseCardsSnapshot(
  subject: SequentialCardsDefinition,
  input: string | object,
): CardsBookSnapshot {
  const value = preflightSnapshotInput(
    typeof input === 'string' ? parseSnapshotJson(input) : input,
  );
  const candidate = assertSnapshotRecord(value, '$');
  assertSnapshotKeys(candidate, snapshotKeysFor(subject), '$');
  if (candidate.roundingSeed !== undefined && candidate.roundingSeed !== null)
    assertWireHex(candidate.roundingSeed, '$.roundingSeed');
  if (candidate.settlementReason !== undefined && candidate.settlementReason !== null)
    assertWireString(candidate.settlementReason, '$.settlementReason');
  if (
    candidate.schema !== CARDS_BOOK_SCHEMA ||
    typeof candidate.terminal !== 'boolean' ||
    !Number.isSafeInteger(candidate.stepRevision) ||
    !Number.isSafeInteger(candidate.ledgerRevision) ||
    !Array.isArray(candidate.choices) ||
    !Array.isArray(candidate.steps) ||
    !Array.isArray(candidate.selections) ||
    !Array.isArray(candidate.decisions) ||
    !Array.isArray(candidate.receipts)
  )
    fail('INVALID_SNAPSHOT', 'Snapshot scalar fields are invalid', '$');
  const definition = assertSnapshotRecord(candidate.definition, '$.definition');
  assertSnapshotKeys(definition, ['id', 'version', 'fingerprint'], '$.definition');
  assertWireString(definition.id, '$.definition.id');
  assertWireString(definition.version, '$.definition.version');
  assertWireHex(definition.fingerprint, '$.definition.fingerprint');
  if (candidate.roundId !== null) assertWireString(candidate.roundId, '$.roundId');
  if (candidate.seedCommitment !== null)
    assertWireHex(candidate.seedCommitment, '$.seedCommitment');
  if (candidate.clientSeed !== null) assertWireString(candidate.clientSeed, '$.clientSeed');
  assertWireString(candidate.liquidBalance, '$.liquidBalance');
  if (candidate.capBasisStake !== null)
    assertWireString(candidate.capBasisStake, '$.capBasisStake');
  if (candidate.selections.length > ENGINE_LIMITS.maxRoundClaims)
    fail('INVALID_SNAPSHOT', 'Too many selections', '$.selections');
  if (candidate.decisions.length > ENGINE_LIMITS.maxReceipts)
    fail('INVALID_SNAPSHOT', 'Too many decisions', '$.decisions');
  candidate.selections.forEach((item, index) => {
    const selection = assertSnapshotRecord(item, `$.selections[${index}]`);
    assertSnapshotKeys(selection, SELECTION_KEYS, `$.selections[${index}]`);
    assertWireString(selection.id, `$.selections[${index}].id`);
    assertWireString(selection.kind, `$.selections[${index}].kind`);
    assertWireString(selection.status, `$.selections[${index}].status`);
    assertWireString(selection.stake, `$.selections[${index}].stake`);
    assertWireString(selection.credited, `$.selections[${index}].credited`);
    if (selection.marketId !== null)
      assertWireString(selection.marketId, `$.selections[${index}].marketId`);
    if (selection.openedPosition !== null && !Number.isSafeInteger(selection.openedPosition))
      fail(
        'INVALID_SNAPSHOT',
        'Opened position must be an integer or null',
        `$.selections[${index}]`,
      );
    if (
      !Number.isSafeInteger(selection.decidedAtStepRevision) ||
      !Array.isArray(selection.positions) ||
      selection.positions.length > ENGINE_LIMITS.maxOutcomes ||
      selection.positions.some((position: unknown) => !Number.isSafeInteger(position))
    )
      fail('INVALID_SNAPSHOT', 'Selection counters are invalid', `$.selections[${index}]`);
    const claim = assertSnapshotRecord(selection.claim, `$.selections[${index}].claim`);
    assertSnapshotKeys(claim, ['numerator', 'denominator'], `$.selections[${index}].claim`);
    assertWireString(claim.numerator, `$.selections[${index}].claim.numerator`);
    assertWireString(claim.denominator, `$.selections[${index}].claim.denominator`);
  });
  candidate.decisions.forEach((item, index) => {
    const decision = assertSnapshotRecord(item, `$.decisions[${index}]`);
    assertSnapshotKeys(
      decision,
      ['selectionId', 'action', 'stepRevision', 'positions'],
      `$.decisions[${index}]`,
    );
    assertWireString(decision.selectionId, `$.decisions[${index}].selectionId`);
    assertWireString(decision.action, `$.decisions[${index}].action`);
    if (!Number.isSafeInteger(decision.stepRevision) || !Array.isArray(decision.positions))
      fail('INVALID_SNAPSHOT', 'Decision fields are invalid', `$.decisions[${index}]`);
    // The cover's *rules* are the definition's and `restore()` applies them; its
    // element type is this parser's, because every sibling array is typed here
    // and one untyped array is all it takes to turn a hostile snapshot into a
    // raw `TypeError` in the BigInt arithmetic downstream.
    if (decision.positions.length > ENGINE_LIMITS.maxOutcomes)
      fail('INVALID_SNAPSHOT', 'Decision cover is too wide', `$.decisions[${index}].positions`);
    decision.positions.forEach((position: unknown, slot: number) => {
      if (!Number.isSafeInteger(position))
        fail(
          'INVALID_SNAPSHOT',
          'Decision cover must hold integers',
          `$.decisions[${index}].positions[${slot}]`,
        );
    });
  });
  if (candidate.settlement !== null) {
    const settlement = assertSnapshotRecord(candidate.settlement, '$.settlement');
    assertSnapshotKeys(
      settlement,
      ['revealedSeed', 'commitment', 'objectiveRank', 'objectivePosition'],
      '$.settlement',
    );
    assertWireHex(settlement.revealedSeed, '$.settlement.revealedSeed');
    assertWireHex(settlement.commitment, '$.settlement.commitment');
    if (
      !Number.isSafeInteger(settlement.objectiveRank) ||
      !Number.isSafeInteger(settlement.objectivePosition)
    )
      fail('INVALID_SNAPSHOT', 'Settlement counters are invalid', '$.settlement');
  }
  candidate.receipts.forEach((item, index) => {
    const entry = assertSnapshotRecord(item, `$.receipts[${index}]`);
    assertSnapshotKeys(entry, ['fingerprint', 'receipt'], `$.receipts[${index}]`);
    assertWireHex(entry.fingerprint, `$.receipts[${index}].fingerprint`);
    const receipt = assertSnapshotRecord(entry.receipt, `$.receipts[${index}].receipt`);
    assertSnapshotKeys(receipt, RECEIPT_WIRE_KEYS, `$.receipts[${index}].receipt`);
  });
  assertSnapshotRevision(candidate.stepRevision as number, '$.stepRevision');
  assertSnapshotRevision(candidate.ledgerRevision as number, '$.ledgerRevision');
  assertWireHex(candidate.snapshotHash, '$.snapshotHash');
  assertSnapshotSize(candidate);
  return candidate as unknown as CardsBookSnapshot;
}

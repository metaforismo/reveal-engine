import { fail } from '../../api/errors.js';
import { ENGINE_LIMITS } from '../../api/limits.js';
import {
  CommandLedger,
  RECEIPT_WIRE_KEYS,
  commandFingerprint,
  fromWireReceipt,
  toWireReceipt,
  type Receipt as LedgerReceipt,
  type StoredReceipt,
  type WireReceipt,
} from '../../core/ledger.js';
import { payableWithinCap, type Payable } from '../../core/payments.js';
import { normalizeSeed } from '../../core/random.js';
import { equal, multiply, rational, type Rational } from '../../core/rational.js';
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
import { adapterFingerprint, assertPosteriorForGame } from './adapter.js';
import {
  ROUND_BOOK_SCHEMA,
  type EvidenceEvent,
  type GameDefinition,
  type Posterior,
} from './contracts.js';
import { evidenceEqual, verifyTranscriptDetailed } from './fairness.js';
import { fairValueClaim, initialPosterior, quote, updatePosterior } from './posterior.js';
import { deserializeTranscript, serializeTranscript, transcriptToWire } from './transcript.js';
import { assertBoundedBigInt, assertEvidenceEvent, assertGameDefinition } from './validation.js';

/** Receipt actions this module mints. */
export const ROUND_ACTIONS = Object.freeze(['open', 'sell', 'settle'] as const);
export type RoundAction = (typeof ROUND_ACTIONS)[number];
export type Receipt = LedgerReceipt<RoundAction>;

export interface Position {
  readonly outcome: number;
  readonly contingentPayout: Rational;
  readonly stake: bigint;
  readonly capBasisStake: bigint;
  readonly entryCount: number;
  readonly openedAtFrameRevision: number;
}
export interface OpenRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;
  readonly outcome: number;
  readonly stake: bigint;
}
export interface SellRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;
}
export interface SettleRequest {
  readonly idempotencyKey: string;
  readonly expectedFrameRevision: number;
  readonly revealedSeed: string;
  readonly transcript: unknown;
}
export interface FrameState {
  readonly revision: number;
  readonly posterior: Posterior;
}
export interface PublishedRoundBinding {
  readonly roundId: string;
  readonly commitment: string;
}

export interface RoundBookSnapshot {
  readonly schema: typeof ROUND_BOOK_SCHEMA;
  readonly publishedRound: PublishedRoundBinding | null;
  readonly adapter: { readonly id: string; readonly version: string; readonly fingerprint: string };
  readonly frameRevision: number;
  readonly ledgerRevision: number;
  readonly posterior: { readonly weights: readonly string[]; readonly total: string };
  readonly evidence: readonly {
    readonly index: number;
    readonly target: number;
    readonly favour: string;
    readonly other: string;
    readonly label: string;
  }[];
  readonly openHistory: readonly {
    readonly outcome: number;
    readonly contingentPayout: WireRational;
    readonly stake: string;
    readonly capBasisStake: string;
    readonly entryCount: number;
    readonly openedAtFrameRevision: number;
  }[];
  readonly settlementProof: null | {
    readonly revealedSeed: string;
    readonly transcript: unknown;
  };
  readonly position: null | {
    readonly outcome: number;
    readonly contingentPayout: WireRational;
    readonly stake: string;
    readonly capBasisStake: string;
    readonly entryCount: number;
    readonly openedAtFrameRevision: number;
  };
  readonly entryCount: number;
  readonly capBasisStake: string | null;
  readonly liquidBalance: string;
  readonly terminal: boolean;
  readonly receipts: readonly { readonly fingerprint: string; readonly receipt: WireReceipt }[];
  readonly snapshotHash: string;
}

/**
 * Single-position progressive-market round book.
 *
 * The book owns the game-shaped state machine — posterior, applied evidence, and
 * the one open position. Everything money-shaped (command serialization,
 * idempotency, receipts, cap-chain accounting) lives in the shared
 * `CommandLedger`, so a multi-position or paytable module reuses it unchanged.
 */
export class RoundBook {
  #posterior: Posterior;
  #position: Position | undefined;
  #evidence: EvidenceEvent[] = [];
  #entryCount = 0;
  #openHistory: Position[] = [];
  #settlementProof:
    | {
        readonly revealedSeed: string;
        readonly transcript: ReturnType<typeof deserializeTranscript>;
      }
    | undefined;
  #frameRevision = 0;
  #terminal = false;
  #publishedRound: PublishedRoundBinding | undefined;
  readonly #ledger: CommandLedger;

  constructor(
    readonly game: GameDefinition,
    posterior: Posterior,
    publishedRound?: PublishedRoundBinding,
  ) {
    assertGameDefinition(game);
    assertPosteriorForGame(posterior, game);
    this.#posterior = freezePosterior(posterior);
    if (publishedRound !== undefined) this.#publishedRound = copyBinding(publishedRound);
    this.#ledger = new CommandLedger({ maxWinMultiple: game.risk.maxWinMultiple });
  }
  get publishedRound(): PublishedRoundBinding | undefined {
    return this.#publishedRound;
  }
  bindRound(binding: PublishedRoundBinding): PublishedRoundBinding {
    const copied = copyBinding(binding);
    if (
      this.#frameRevision !== 0 ||
      this.#entryCount !== 0 ||
      this.#evidence.length !== 0 ||
      this.#ledger.ledgerRevision !== 0
    )
      fail('COMMITMENT_MISMATCH', 'Round binding must be published before play');
    if (
      this.#publishedRound &&
      (this.#publishedRound.roundId !== copied.roundId ||
        this.#publishedRound.commitment !== copied.commitment)
    )
      fail('COMMITMENT_MISMATCH', 'Published round binding cannot be replaced');
    this.#publishedRound ??= copied;
    return this.#publishedRound;
  }
  get frame(): FrameState {
    return Object.freeze({ revision: this.#frameRevision, posterior: this.#posterior });
  }
  get ledgerRevision(): number {
    return this.#ledger.ledgerRevision;
  }
  get terminal(): boolean {
    return this.#terminal;
  }
  get position(): Position | undefined {
    return this.#position;
  }
  get liquidBalance(): bigint {
    return this.#ledger.liquidBalance;
  }
  get capBasisStake(): bigint | undefined {
    return this.#ledger.capBasisStake;
  }

  async advanceFrame(event: EvidenceEvent): Promise<FrameState> {
    this.#requirePublishedRound();
    return this.#ledger.serial(() => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Cannot advance a terminal round');
      assertEvidenceEvent(event, this.game.outcomes.length, this.#frameRevision, '$.event');
      if (this.#frameRevision >= this.game.evidence.eventCount)
        fail('INVALID_EVIDENCE', 'Evidence schedule is already complete');
      const next = updatePosterior(this.#posterior, event);
      this.#posterior = freezePosterior(next);
      this.#evidence.push(Object.freeze({ ...event }));
      this.#frameRevision += 1;
      return this.frame;
    });
  }

  async open(request: OpenRequest): Promise<Receipt> {
    assertRequestRecord(request, 'OPEN_REJECTED');
    // Caller-owned request objects are an untrusted wire boundary. Snapshot
    // every field exactly once before validation and never cross the async
    // ledger boundary with a reference back into the request.
    const idempotencyKey = request.idempotencyKey;
    const expectedFrameRevision = request.expectedFrameRevision;
    const outcome = request.outcome;
    const stake = request.stake;
    assertIdempotencyKey(idempotencyKey);
    assertRevisionInput(expectedFrameRevision, '$.expectedFrameRevision');
    assertBoundedBigInt(stake, '$.stake', true);
    if (!Number.isSafeInteger(outcome) || outcome < 0 || outcome >= this.game.outcomes.length)
      fail('UNKNOWN_OUTCOME', 'Unknown outcome', '$.outcome');
    const binding = this.#requirePublishedRound();
    const fingerprint = commandFingerprint('open', [
      binding.roundId,
      binding.commitment,
      expectedFrameRevision,
      outcome,
      stake,
    ]);
    return this.#ledger.execute<RoundAction>(idempotencyKey, fingerprint, () => {
      this.#assertFrame(expectedFrameRevision);
      if (this.#terminal || this.#position) fail('OPEN_REJECTED', 'Position cannot be opened');
      const first = this.#entryCount === 0;
      if (!first && stake > this.#ledger.liquidBalance)
        fail(
          'OPEN_REJECTED',
          'Re-entry must be self-financing from liquidated proceeds',
          '$.stake',
        );
      const maxRides = this.game.risk.continuation?.maxRides;
      if (!first && maxRides !== undefined && this.#entryCount > maxRides)
        fail('OPEN_REJECTED', 'Round continuation limit reached', '$.expectedFrameRevision', {
          maxRides,
          rides: this.#entryCount,
        });
      const multiplier = quote(
        this.game,
        this.#posterior,
        outcome,
        first,
        this.#frameRevision,
      ).multiplier;
      const claim = multiply(rational(stake), multiplier);
      const capBasis = this.#ledger.capBasisStake ?? stake;
      const position = Object.freeze({
        outcome,
        contingentPayout: claim,
        stake,
        capBasisStake: capBasis,
        entryCount: this.#entryCount + 1,
        openedAtFrameRevision: this.#frameRevision,
      });
      const receipt = this.#mint(idempotencyKey, fingerprint, 'open', stake, 0n, false);
      this.#ledger.fundStake(stake, first ? 'external' : 'recycled');
      this.#position = position;
      this.#openHistory.push(position);
      this.#entryCount += 1;
      return receipt;
    });
  }

  async sell(request: SellRequest): Promise<Receipt> {
    assertRequestRecord(request, 'SELL_REJECTED');
    const idempotencyKey = request.idempotencyKey;
    const expectedFrameRevision = request.expectedFrameRevision;
    assertIdempotencyKey(idempotencyKey);
    assertRevisionInput(expectedFrameRevision, '$.expectedFrameRevision');
    const binding = this.#requirePublishedRound();
    const fingerprint = commandFingerprint('sell', [
      binding.roundId,
      binding.commitment,
      expectedFrameRevision,
    ]);
    return this.#ledger.execute<RoundAction>(idempotencyKey, fingerprint, () => {
      this.#assertFrame(expectedFrameRevision);
      if (this.#terminal || !this.#position || this.#ledger.capBasisStake === undefined)
        fail('SELL_REJECTED', 'No active position to sell');
      const theoretical = fairValueClaim(
        this.#position.contingentPayout,
        this.#posterior,
        this.#position.outcome,
        this.game.pricing.liquidationSpread,
      );
      // One ledger call prices, mints, and credits: the cap chain only holds if
      // every credit path performs all three, so the ledger owns the sequence.
      return this.#ledger.creditClaim(theoretical, (result) => {
        const receipt = this.#mint(
          idempotencyKey,
          fingerprint,
          'sell',
          0n,
          result.credited,
          result.capped,
        );
        this.#position = undefined;
        return receipt;
      });
    });
  }

  async settle(request: SettleRequest): Promise<Receipt> {
    assertRequestRecord(request, 'SETTLE_REJECTED');
    const idempotencyKey = request.idempotencyKey;
    const expectedFrameRevision = request.expectedFrameRevision;
    const rawSeed = request.revealedSeed;
    const rawTranscript = request.transcript;
    assertIdempotencyKey(idempotencyKey);
    assertRevisionInput(expectedFrameRevision, '$.expectedFrameRevision');
    const binding = this.#requirePublishedRound();
    const revealedSeed = normalizeSeed(rawSeed);
    const transcript = deserializeTranscript(rawTranscript);
    const fingerprint = commandFingerprint('settle', [
      binding.roundId,
      binding.commitment,
      expectedFrameRevision,
      revealedSeed,
      serializeTranscript(transcript),
    ]);
    return this.#ledger.execute<RoundAction>(idempotencyKey, fingerprint, () => {
      this.#assertFrame(expectedFrameRevision);
      if (this.#terminal) fail('SETTLE_REJECTED', 'Round is already terminal');
      if (this.#frameRevision !== this.game.evidence.eventCount)
        fail('SETTLE_REJECTED', 'Settlement requires the complete evidence schedule');
      if (
        transcript.context.roundId !== binding.roundId ||
        transcript.commitment !== binding.commitment
      )
        fail(
          'COMMITMENT_MISMATCH',
          'Settlement proof does not open the published round binding',
          '$.transcript.commitment',
        );
      const verification = verifyTranscriptDetailed(revealedSeed, this.game, transcript);
      if (!verification.ok)
        fail('INVALID_TRANSCRIPT', verification.message, verification.path, {
          verificationCode: verification.code,
        });
      if (!evidenceEqual(this.#evidence, transcript.evidence))
        fail('TRANSCRIPT_MISMATCH', 'Applied frame evidence differs from settlement proof');
      const theoretical =
        this.#position && this.#position.outcome === transcript.truth
          ? this.#position.contingentPayout
          : rational(0n);
      const close = (result: Payable): Receipt => {
        const receipt = this.#mint(
          idempotencyKey,
          fingerprint,
          'settle',
          0n,
          result.credited,
          result.capped,
        );
        this.#terminal = true;
        this.#settlementProof = Object.freeze({ revealedSeed, transcript });
        this.#position = undefined;
        return receipt;
      };
      // A round that never took a stake has no cap chain to credit against, so
      // there is nothing to credit and no ceiling to measure it against.
      return this.#ledger.capBasisStake === undefined
        ? close(Object.freeze({ theoretical, credited: 0n, capped: false }))
        : this.#ledger.creditClaim(theoretical, close);
    });
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }
  snapshot(): RoundBookSnapshot {
    const capBasisStake = this.#ledger.capBasisStake;
    const base = {
      schema: ROUND_BOOK_SCHEMA,
      publishedRound: this.#publishedRound ?? null,
      adapter: Object.freeze({
        id: this.game.id,
        version: this.game.adapterVersion,
        fingerprint: adapterFingerprint(this.game),
      }),
      frameRevision: this.#frameRevision,
      ledgerRevision: this.#ledger.ledgerRevision,
      posterior: Object.freeze({
        weights: Object.freeze(this.#posterior.weights.map(String)),
        total: String(this.#posterior.total),
      }),
      evidence: Object.freeze(
        this.#evidence.map((event) =>
          Object.freeze({ ...event, favour: String(event.favour), other: String(event.other) }),
        ),
      ),
      openHistory: Object.freeze(
        this.#openHistory.map((position) =>
          Object.freeze({
            outcome: position.outcome,
            contingentPayout: toWireRational(position.contingentPayout),
            stake: String(position.stake),
            capBasisStake: String(position.capBasisStake),
            entryCount: position.entryCount,
            openedAtFrameRevision: position.openedAtFrameRevision,
          }),
        ),
      ),
      settlementProof: this.#settlementProof
        ? Object.freeze({
            revealedSeed: this.#settlementProof.revealedSeed,
            transcript: transcriptToWire(this.#settlementProof.transcript),
          })
        : null,
      position: this.#position
        ? Object.freeze({
            outcome: this.#position.outcome,
            contingentPayout: toWireRational(this.#position.contingentPayout),
            stake: String(this.#position.stake),
            capBasisStake: String(this.#position.capBasisStake),
            entryCount: this.#position.entryCount,
            openedAtFrameRevision: this.#position.openedAtFrameRevision,
          })
        : null,
      entryCount: this.#entryCount,
      capBasisStake: capBasisStake === undefined ? null : String(capBasisStake),
      liquidBalance: String(this.#ledger.liquidBalance),
      terminal: this.#terminal,
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

  static restore(
    game: GameDefinition,
    input: string | RoundBookSnapshot,
    expectedBinding: PublishedRoundBinding | null,
  ): RoundBook;
  static restore(
    game: GameDefinition,
    input: string | RoundBookSnapshot,
    expectedBinding?: PublishedRoundBinding | null,
  ): RoundBook {
    const raw = parseSnapshotInput(input);
    if (
      raw.schema !== ROUND_BOOK_SCHEMA ||
      raw.snapshotHash !== snapshotHash({ ...raw, snapshotHash: undefined })
    )
      fail('INVALID_SNAPSHOT', 'Snapshot hash or schema is invalid');
    if (
      raw.adapter.id !== game.id ||
      raw.adapter.version !== game.adapterVersion ||
      raw.adapter.fingerprint !== adapterFingerprint(game)
    )
      fail('ADAPTER_MISMATCH', 'Snapshot belongs to another adapter');
    const posterior: Posterior = Object.freeze({
      adapterId: game.id,
      adapterVersion: game.adapterVersion,
      adapterFingerprint: raw.adapter.fingerprint,
      weights: Object.freeze(
        raw.posterior.weights.map((value) => parseWireBigInt(value, '$.posterior.weights')),
      ),
      total: parseWireBigInt(raw.posterior.total, '$.posterior.total'),
    });
    assertPosteriorForGame(posterior, game);
    const snapshotBinding =
      raw.publishedRound === null ? undefined : copyBinding(raw.publishedRound);
    if (expectedBinding === undefined)
      fail(
        'COMMITMENT_MISMATCH',
        'Restore requires the independently published round binding or explicit null',
        '$.expectedBinding',
      );
    const wanted = expectedBinding === null ? undefined : copyBinding(expectedBinding);
    if (
      (snapshotBinding === undefined) !== (wanted === undefined) ||
      (snapshotBinding !== undefined &&
        wanted !== undefined &&
        (snapshotBinding.roundId !== wanted.roundId ||
          snapshotBinding.commitment !== wanted.commitment))
    )
      fail(
        'COMMITMENT_MISMATCH',
        'Snapshot does not match the expected published round',
        '$.expectedBinding',
      );
    const book = new RoundBook(game, posterior, snapshotBinding);
    book.#frameRevision = assertSnapshotRevision(raw.frameRevision, '$.frameRevision');
    book.#evidence = raw.evidence.map((event, index) =>
      Object.freeze({
        index: event.index,
        target: event.target,
        favour: parseWireBigInt(event.favour, `$.evidence[${index}].favour`),
        other: parseWireBigInt(event.other, `$.evidence[${index}].other`),
        label: event.label,
      }),
    );
    book.#evidence.forEach((event, index) =>
      assertEvidenceEvent(event, game.outcomes.length, index, `$.evidence[${index}]`),
    );
    if (book.#evidence.length !== book.#frameRevision)
      fail('INVALID_SNAPSHOT', 'Evidence/frame revision mismatch');
    const replayed = book.#evidence.reduce(updatePosterior, initialPosterior(game));
    if (
      replayed.total !== posterior.total ||
      replayed.weights.some((weight, index) => weight !== posterior.weights[index])
    )
      fail('INVALID_SNAPSHOT', 'Posterior does not replay from snapshot evidence');
    const ledgerRevision = assertSnapshotRevision(raw.ledgerRevision, '$.ledgerRevision');
    book.#entryCount = assertSnapshotRevision(raw.entryCount, '$.entryCount');
    const capBasisStake =
      raw.capBasisStake === null
        ? undefined
        : parseWireBigInt(raw.capBasisStake, '$.capBasisStake');
    const liquidBalance = parseWireBigInt(raw.liquidBalance, '$.liquidBalance', true);
    book.#terminal = raw.terminal;
    book.#openHistory = raw.openHistory.map((position) => parseWirePosition(position));
    book.#settlementProof =
      raw.settlementProof === null
        ? undefined
        : Object.freeze({
            revealedSeed: normalizeSeed(raw.settlementProof.revealedSeed),
            transcript: deserializeTranscript(raw.settlementProof.transcript),
          });
    book.#position = raw.position
      ? Object.freeze({
          outcome: raw.position.outcome,
          contingentPayout: fromWireRational(raw.position.contingentPayout),
          stake: parseWireBigInt(raw.position.stake, '$.position.stake'),
          capBasisStake: parseWireBigInt(raw.position.capBasisStake, '$.position.capBasisStake'),
          entryCount: assertSnapshotRevision(raw.position.entryCount, '$.position.entryCount'),
          openedAtFrameRevision: assertSnapshotRevision(
            raw.position.openedAtFrameRevision,
            '$.position.openedAtFrameRevision',
          ),
        })
      : undefined;
    let reconstructedLiquid = 0n;
    let openCount = 0;
    let activePosition = false;
    let settled = false;
    let firstStake: bigint | undefined;
    let lastOpenStake: bigint | undefined;
    let lastOpenFingerprint: string | undefined;
    const stored: StoredReceipt<RoundAction>[] = raw.receipts.map((entry) => ({
      fingerprint: entry.fingerprint,
      receipt: fromWireReceipt<RoundAction>(entry.receipt, ROUND_ACTIONS),
    }));
    book.#ledger.install(stored, book.#frameRevision, (receipt) => {
      if (receipt.action === 'open') {
        if (settled || activePosition || receipt.debited <= 0n || receipt.credited !== 0n)
          fail('INVALID_SNAPSHOT', 'Receipt sequence violates the round state machine');
        if (openCount > 0) {
          if (receipt.debited > reconstructedLiquid)
            fail('INVALID_SNAPSHOT', 'Re-entry is not self-financing');
          reconstructedLiquid -= receipt.debited;
        }
        firstStake ??= receipt.debited;
        lastOpenStake = receipt.debited;
        lastOpenFingerprint = receipt.commandFingerprint;
        openCount += 1;
        activePosition = true;
      } else if (receipt.action === 'sell') {
        if (settled || !activePosition || receipt.debited !== 0n)
          fail('INVALID_SNAPSHOT', 'Receipt sequence violates the round state machine');
        reconstructedLiquid += receipt.credited;
        activePosition = false;
      } else {
        if (settled || receipt.debited !== 0n)
          fail('INVALID_SNAPSHOT', 'Receipt sequence violates the round state machine');
        reconstructedLiquid += receipt.credited;
        settled = true;
        activePosition = false;
      }
    });
    if (
      book.#entryCount !== openCount ||
      book.#openHistory.length !== openCount ||
      book.#terminal !== settled ||
      Boolean(book.#position) !== activePosition ||
      (firstStake === undefined) !== (capBasisStake === undefined) ||
      (firstStake !== undefined && firstStake !== capBasisStake)
    )
      fail('INVALID_SNAPSHOT', 'Snapshot state invariants failed');
    if (reconstructedLiquid !== liquidBalance)
      fail('INVALID_SNAPSHOT', 'Snapshot accounting does not conserve liquid value');
    let replayLiquid = 0n;
    let replayPosition: Position | undefined;
    let replayOpen = 0;
    for (const entry of [...stored].sort(
      (left, right) => left.receipt.ledgerRevision - right.receipt.ledgerRevision,
    )) {
      const receipt = entry.receipt;
      if (receipt.action === 'open') {
        const position = book.#openHistory[replayOpen++];
        if (
          !position ||
          receipt.debited !== position.stake ||
          entry.fingerprint !==
            commandFingerprint('open', [
              ...(book.#publishedRound
                ? [book.#publishedRound.roundId, book.#publishedRound.commitment]
                : []),
              position.openedAtFrameRevision,
              position.outcome,
              position.stake,
            ])
        )
          fail('INVALID_SNAPSHOT', 'Open history does not match its receipt');
        const atOpen = book.#evidence
          .slice(0, position.openedAtFrameRevision)
          .reduce(updatePosterior, initialPosterior(game));
        const expected = multiply(
          rational(position.stake),
          quote(
            game,
            atOpen,
            position.outcome,
            position.entryCount === 1,
            position.openedAtFrameRevision,
          ).multiplier,
        );
        if (!equal(expected, position.contingentPayout))
          fail('INVALID_SNAPSHOT', 'Historical position does not re-derive from its price');
        if (position.entryCount > 1) replayLiquid -= position.stake;
        replayPosition = position;
      } else if (receipt.action === 'sell') {
        if (!replayPosition || capBasisStake === undefined)
          fail('INVALID_SNAPSHOT', 'Sell has no replayed position');
        const atSell = book.#evidence
          .slice(0, receipt.frameRevision)
          .reduce(updatePosterior, initialPosterior(game));
        const result = payableWithinCap(
          fairValueClaim(
            replayPosition.contingentPayout,
            atSell,
            replayPosition.outcome,
            game.pricing.liquidationSpread,
          ),
          capBasisStake,
          game.risk.maxWinMultiple,
          replayLiquid,
        );
        if (receipt.credited !== result.credited || receipt.capped !== result.capped)
          fail('INVALID_SNAPSHOT', 'Historical sell credit does not re-derive');
        replayLiquid += result.credited;
        replayPosition = undefined;
      } else {
        if (!book.#settlementProof) fail('INVALID_SNAPSHOT', 'Settled snapshot lacks its proof');
        const proof = book.#settlementProof;
        const verification = verifyTranscriptDetailed(proof.revealedSeed, game, proof.transcript);
        if (
          !verification.ok ||
          proof.transcript.commitment !== book.#publishedRound?.commitment ||
          proof.transcript.context.roundId !== book.#publishedRound?.roundId ||
          !evidenceEqual(book.#evidence, proof.transcript.evidence)
        )
          fail('INVALID_SNAPSHOT', 'Stored settlement proof is invalid');
        const theoretical =
          replayPosition?.outcome === proof.transcript.truth
            ? replayPosition.contingentPayout
            : rational(0n);
        const result =
          capBasisStake === undefined
            ? Object.freeze({ theoretical, credited: 0n, capped: false })
            : payableWithinCap(theoretical, capBasisStake, game.risk.maxWinMultiple, replayLiquid);
        if (receipt.credited !== result.credited || receipt.capped !== result.capped)
          fail('INVALID_SNAPSHOT', 'Historical settlement credit does not re-derive');
        replayLiquid += result.credited;
        replayPosition = undefined;
      }
    }
    if (replayLiquid !== liquidBalance)
      fail('INVALID_SNAPSHOT', 'Replayed credits do not conserve liquid value');
    book.#ledger.restoreBalances({ ledgerRevision, liquidBalance, capBasisStake });
    const position = book.#position;
    if (position) {
      if (
        position.outcome < 0 ||
        position.outcome >= game.outcomes.length ||
        position.capBasisStake !== capBasisStake ||
        position.entryCount !== openCount ||
        position.stake !== lastOpenStake ||
        position.openedAtFrameRevision > book.#frameRevision
      )
        fail('INVALID_SNAPSHOT', 'Snapshot position is inconsistent');
      // What the player bet is re-derived from the receipt log, never read out
      // of the snapshot: the open receipt's fingerprint is
      // `commandFingerprint('open', [frame, outcome, stake])`, so a rewritten
      // outcome cannot survive its own receipt under a recomputed checksum.
      if (
        lastOpenFingerprint !==
        commandFingerprint('open', [
          ...(book.#publishedRound
            ? [book.#publishedRound.roundId, book.#publishedRound.commitment]
            : []),
          position.openedAtFrameRevision,
          position.outcome,
          position.stake,
        ])
      )
        fail(
          'INVALID_SNAPSHOT',
          'Position does not match the open receipt that created it',
          '$.position.outcome',
        );
      // The claim is a pure function of the price at the frame the position was
      // opened at, and that price replays from the already-verified evidence
      // chain — so the payout is recomputed rather than trusted.
      const atOpen = book.#evidence
        .slice(0, position.openedAtFrameRevision)
        .reduce(updatePosterior, initialPosterior(game));
      const expectedPayout = multiply(
        rational(position.stake),
        quote(
          game,
          atOpen,
          position.outcome,
          position.entryCount === 1,
          position.openedAtFrameRevision,
        ).multiplier,
      );
      if (!equal(expectedPayout, position.contingentPayout))
        fail(
          'INVALID_SNAPSHOT',
          'Position payout does not re-derive from the replayed price',
          '$.position.contingentPayout',
        );
    }
    return book;
  }

  #assertFrame(expected: number): void {
    if (!Number.isSafeInteger(expected) || expected !== this.#frameRevision)
      fail('STALE_FRAME', 'Expected frame revision is stale', '$.expectedFrameRevision', {
        expected: this.#frameRevision,
        received: expected,
      });
  }
  #requirePublishedRound(): PublishedRoundBinding {
    if (!this.#publishedRound)
      fail('COMMITMENT_MISMATCH', 'A round binding must be published before play');
    return this.#publishedRound;
  }
  #mint(
    key: string,
    fingerprint: string,
    action: RoundAction,
    debited: bigint,
    credited: bigint,
    capped: boolean,
  ): Receipt {
    return this.#ledger.mint(
      key,
      fingerprint,
      action,
      this.#frameRevision,
      debited,
      credited,
      capped,
    );
  }
}

function assertRequestRecord(
  value: unknown,
  code: 'OPEN_REJECTED' | 'SELL_REJECTED' | 'SETTLE_REJECTED',
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(code, 'Request must be an object');
}
function assertIdempotencyKey(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > ENGINE_LIMITS.maxIdempotencyKeyBytes
  )
    fail('IDEMPOTENCY_CONFLICT', 'Invalid idempotency key', '$.idempotencyKey');
}
function assertRevisionInput(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    fail('STALE_FRAME', 'Expected frame revision is invalid', path);
}
function freezePosterior(posterior: Posterior): Posterior {
  return Object.freeze({ ...posterior, weights: Object.freeze([...posterior.weights]) });
}
function copyBinding(value: PublishedRoundBinding): PublishedRoundBinding {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.roundId !== 'string' ||
    value.roundId.length === 0 ||
    Buffer.byteLength(value.roundId, 'utf8') > ENGINE_LIMITS.maxIdentifierBytes ||
    typeof value.commitment !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.commitment)
  )
    fail('COMMITMENT_MISMATCH', 'Published round binding is malformed');
  return Object.freeze({ roundId: value.roundId, commitment: value.commitment });
}
function parseWirePosition(position: RoundBookSnapshot['openHistory'][number]): Position {
  return Object.freeze({
    outcome: position.outcome,
    contingentPayout: fromWireRational(position.contingentPayout),
    stake: parseWireBigInt(position.stake, '$.openHistory.stake'),
    capBasisStake: parseWireBigInt(position.capBasisStake, '$.openHistory.capBasisStake'),
    entryCount: assertSnapshotRevision(position.entryCount, '$.openHistory.entryCount'),
    openedAtFrameRevision: assertSnapshotRevision(
      position.openedAtFrameRevision,
      '$.openHistory.openedAtFrameRevision',
    ),
  });
}

function parseSnapshotInput(input: string | RoundBookSnapshot): RoundBookSnapshot {
  const value = preflightSnapshotInput(
    typeof input === 'string' ? parseSnapshotJson(input) : input,
  );
  const candidate = assertSnapshotRecord(value, '$');
  assertSnapshotKeys(
    candidate,
    [
      'schema',
      'publishedRound',
      'adapter',
      'frameRevision',
      'ledgerRevision',
      'posterior',
      'evidence',
      'openHistory',
      'settlementProof',
      'position',
      'entryCount',
      'capBasisStake',
      'liquidBalance',
      'terminal',
      'receipts',
      'snapshotHash',
    ],
    '$',
  );
  const adapter = assertSnapshotRecord(candidate.adapter, '$.adapter');
  assertSnapshotKeys(adapter, ['id', 'version', 'fingerprint'], '$.adapter');
  if (candidate.publishedRound !== null) {
    const binding = assertSnapshotRecord(candidate.publishedRound, '$.publishedRound');
    assertSnapshotKeys(binding, ['roundId', 'commitment'], '$.publishedRound');
    assertWireString(binding.roundId, '$.publishedRound.roundId');
    assertWireHex(binding.commitment, '$.publishedRound.commitment');
  }
  const posterior = assertSnapshotRecord(candidate.posterior, '$.posterior');
  assertSnapshotKeys(posterior, ['weights', 'total'], '$.posterior');
  if (!Array.isArray(posterior.weights))
    fail('INVALID_SNAPSHOT', 'Posterior weights must be an array', '$.posterior.weights');
  posterior.weights.forEach((item, index) =>
    assertWireString(item, `$.posterior.weights[${index}]`),
  );
  assertWireString(posterior.total, '$.posterior.total');
  if (
    !Array.isArray(candidate.evidence) ||
    candidate.evidence.length > ENGINE_LIMITS.maxEvidenceEvents
  )
    fail('INVALID_SNAPSHOT', 'Evidence must be a bounded array', '$.evidence');
  candidate.evidence.forEach((item, index) => {
    const event = assertSnapshotRecord(item, `$.evidence[${index}]`);
    assertSnapshotKeys(
      event,
      ['index', 'target', 'favour', 'other', 'label'],
      `$.evidence[${index}]`,
    );
    if (!Number.isSafeInteger(event.index) || !Number.isSafeInteger(event.target))
      fail(
        'INVALID_SNAPSHOT',
        'Evidence index/target must be safe integers',
        `$.evidence[${index}]`,
      );
    assertWireString(event.favour, `$.evidence[${index}].favour`);
    assertWireString(event.other, `$.evidence[${index}].other`);
    assertWireString(event.label, `$.evidence[${index}].label`);
  });
  if (
    !Array.isArray(candidate.openHistory) ||
    candidate.openHistory.length > ENGINE_LIMITS.maxReceipts
  )
    fail('INVALID_SNAPSHOT', 'Open history must be a bounded array', '$.openHistory');
  candidate.openHistory.forEach((item, index) => {
    const position = assertSnapshotRecord(item, `$.openHistory[${index}]`);
    assertSnapshotKeys(
      position,
      [
        'outcome',
        'contingentPayout',
        'stake',
        'capBasisStake',
        'entryCount',
        'openedAtFrameRevision',
      ],
      `$.openHistory[${index}]`,
    );
  });
  if (candidate.settlementProof !== null) {
    const proof = assertSnapshotRecord(candidate.settlementProof, '$.settlementProof');
    assertSnapshotKeys(proof, ['revealedSeed', 'transcript'], '$.settlementProof');
    assertWireHex(proof.revealedSeed, '$.settlementProof.revealedSeed');
    deserializeTranscript(proof.transcript);
  }
  if (candidate.position !== null) {
    const position = assertSnapshotRecord(candidate.position, '$.position');
    assertSnapshotKeys(
      position,
      [
        'outcome',
        'contingentPayout',
        'stake',
        'capBasisStake',
        'entryCount',
        'openedAtFrameRevision',
      ],
      '$.position',
    );
    const contingentPayout = assertSnapshotRecord(
      position.contingentPayout,
      '$.position.contingentPayout',
    );
    assertSnapshotKeys(
      contingentPayout,
      ['numerator', 'denominator'],
      '$.position.contingentPayout',
    );
    assertWireString(contingentPayout.numerator, '$.position.contingentPayout.numerator');
    assertWireString(contingentPayout.denominator, '$.position.contingentPayout.denominator');
    if (
      !Number.isSafeInteger(position.outcome) ||
      !Number.isSafeInteger(position.entryCount) ||
      !Number.isSafeInteger(position.openedAtFrameRevision)
    )
      fail('INVALID_SNAPSHOT', 'Position counters must be safe integers', '$.position');
    assertWireString(position.stake, '$.position.stake');
    assertWireString(position.capBasisStake, '$.position.capBasisStake');
  }
  if (!Array.isArray(candidate.receipts) || candidate.receipts.length > ENGINE_LIMITS.maxReceipts)
    fail('INVALID_SNAPSHOT', 'Receipts must be a bounded array', '$.receipts');
  candidate.receipts.forEach((item, index) => {
    const stored = assertSnapshotRecord(item, `$.receipts[${index}]`);
    assertSnapshotKeys(stored, ['fingerprint', 'receipt'], `$.receipts[${index}]`);
    assertWireHex(stored.fingerprint, `$.receipts[${index}].fingerprint`);
    const receipt = assertSnapshotRecord(stored.receipt, `$.receipts[${index}].receipt`);
    assertSnapshotKeys(receipt, RECEIPT_WIRE_KEYS, `$.receipts[${index}].receipt`);
    [
      'schema',
      'idempotencyKey',
      'commandFingerprint',
      'action',
      'debited',
      'credited',
      'balanceDelta',
    ].forEach((key) => assertWireString(receipt[key], `$.receipts[${index}].receipt.${key}`));
    if (
      !Number.isSafeInteger(receipt.ledgerRevision) ||
      !Number.isSafeInteger(receipt.frameRevision) ||
      typeof receipt.capped !== 'boolean'
    )
      fail(
        'INVALID_SNAPSHOT',
        'Receipt counters or flag are invalid',
        `$.receipts[${index}].receipt`,
      );
  });
  if (
    candidate.schema !== ROUND_BOOK_SCHEMA ||
    typeof adapter.id !== 'string' ||
    typeof adapter.version !== 'string' ||
    typeof candidate.terminal !== 'boolean' ||
    !Number.isSafeInteger(candidate.frameRevision) ||
    !Number.isSafeInteger(candidate.ledgerRevision) ||
    !Number.isSafeInteger(candidate.entryCount)
  )
    fail('INVALID_SNAPSHOT', 'Snapshot scalar fields are invalid');
  assertWireHex(adapter.fingerprint, '$.adapter.fingerprint');
  assertWireString(candidate.liquidBalance, '$.liquidBalance');
  if (candidate.capBasisStake !== null)
    assertWireString(candidate.capBasisStake, '$.capBasisStake');
  assertWireHex(candidate.snapshotHash, '$.snapshotHash');
  assertSnapshotSize(candidate);
  return candidate as unknown as RoundBookSnapshot;
}

import { createHash } from 'node:crypto';
import { fail } from '../api/errors.js';
import { ENGINE_LIMITS } from '../api/limits.js';
import { adapterFingerprint, assertPosteriorForGame } from '../core/adapter.js';
import type { EvidenceEvent, GameDefinition, Posterior, Transcript } from '../core/contracts.js';
import { evidenceEqual, normalizeSeed, verifyTranscriptDetailed } from '../core/fairness.js';
import { payableWithinCap } from '../core/payments.js';
import { fairValueClaim, initialPosterior, quote, updatePosterior } from '../core/posterior.js';
import { multiply, rational, type Rational } from '../core/rational.js';
import {
  assertBoundedBigInt,
  assertEvidenceEvent,
  assertGameDefinition,
} from '../core/validation.js';
import { encodeFields } from '../internal/canonical.js';
import { deserializeTranscript, serializeTranscript } from '../serialization/transcript.js';

export interface Position {
  readonly outcome: number;
  readonly contingentPayout: Rational;
  readonly stake: bigint;
  readonly capBasisStake: bigint;
  readonly entryCount: number;
  readonly openedAtFrameRevision: number;
}
export interface Receipt {
  readonly schema: 'reveal-engine/receipt-v1';
  readonly idempotencyKey: string;
  readonly commandFingerprint: string;
  readonly action: 'open' | 'sell' | 'settle';
  readonly ledgerRevision: number;
  readonly frameRevision: number;
  readonly debited: bigint;
  readonly credited: bigint;
  readonly balanceDelta: bigint;
  readonly capped: boolean;
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

interface StoredReceipt {
  readonly fingerprint: string;
  readonly receipt: Receipt;
}
interface WireRational {
  readonly numerator: string;
  readonly denominator: string;
}
interface WireReceipt extends Omit<Receipt, 'debited' | 'credited' | 'balanceDelta'> {
  readonly debited: string;
  readonly credited: string;
  readonly balanceDelta: string;
}
export interface RoundBookSnapshot {
  readonly schema: 'reveal-engine/round-book-v1';
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

export class RoundBook {
  #posterior: Posterior;
  #position: Position | undefined;
  #evidence: EvidenceEvent[] = [];
  #entryCount = 0;
  #frameRevision = 0;
  #ledgerRevision = 0;
  #terminal = false;
  #capBasisStake: bigint | undefined;
  #liquidBalance = 0n;
  #receipts = new Map<string, StoredReceipt>();
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly game: GameDefinition,
    posterior: Posterior,
  ) {
    assertGameDefinition(game);
    assertPosteriorForGame(posterior, game);
    this.#posterior = freezePosterior(posterior);
  }
  get frame(): FrameState {
    return Object.freeze({ revision: this.#frameRevision, posterior: this.#posterior });
  }
  get ledgerRevision(): number {
    return this.#ledgerRevision;
  }
  get terminal(): boolean {
    return this.#terminal;
  }
  get position(): Position | undefined {
    return this.#position;
  }
  get liquidBalance(): bigint {
    return this.#liquidBalance;
  }

  async advanceFrame(event: EvidenceEvent): Promise<FrameState> {
    return this.#serial(() => {
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
    assertIdempotencyKey(request.idempotencyKey);
    assertRevisionInput(request.expectedFrameRevision, '$.expectedFrameRevision');
    assertBoundedBigInt(request.stake, '$.stake', true);
    if (
      !Number.isSafeInteger(request.outcome) ||
      request.outcome < 0 ||
      request.outcome >= this.game.outcomes.length
    )
      fail('UNKNOWN_OUTCOME', 'Unknown outcome', '$.outcome');
    const fingerprint = commandFingerprint('open', [
      request.expectedFrameRevision,
      request.outcome,
      request.stake,
    ]);
    return this.#idempotent(request.idempotencyKey, fingerprint, () => {
      this.#assertFrame(request.expectedFrameRevision);
      if (this.#terminal || this.#position) fail('OPEN_REJECTED', 'Position cannot be opened');
      const first = this.#entryCount === 0;
      if (!first && request.stake > this.#liquidBalance)
        fail(
          'OPEN_REJECTED',
          'Re-entry must be self-financing from liquidated proceeds',
          '$.stake',
        );
      const multiplier = quote(
        this.game,
        this.#posterior,
        request.outcome,
        first,
        this.#frameRevision,
      ).multiplier;
      const claim = multiply(rational(request.stake), multiplier);
      const capBasis = this.#capBasisStake ?? request.stake;
      const position = Object.freeze({
        outcome: request.outcome,
        contingentPayout: claim,
        stake: request.stake,
        capBasisStake: capBasis,
        entryCount: this.#entryCount + 1,
        openedAtFrameRevision: this.#frameRevision,
      });
      const receipt = this.#makeReceipt(
        request.idempotencyKey,
        fingerprint,
        'open',
        request.stake,
        0n,
        false,
      );
      this.#position = position;
      this.#entryCount += 1;
      this.#capBasisStake = capBasis;
      if (!first) this.#liquidBalance -= request.stake;
      return receipt;
    });
  }

  async sell(request: SellRequest): Promise<Receipt> {
    assertRequestRecord(request, 'SELL_REJECTED');
    assertIdempotencyKey(request.idempotencyKey);
    assertRevisionInput(request.expectedFrameRevision, '$.expectedFrameRevision');
    const fingerprint = commandFingerprint('sell', [request.expectedFrameRevision]);
    return this.#idempotent(request.idempotencyKey, fingerprint, () => {
      this.#assertFrame(request.expectedFrameRevision);
      if (this.#terminal || !this.#position || this.#capBasisStake === undefined)
        fail('SELL_REJECTED', 'No active position to sell');
      const theoretical = fairValueClaim(
        this.#position.contingentPayout,
        this.#posterior,
        this.#position.outcome,
        this.game.pricing.liquidationSpread,
      );
      const result = payableWithinCap(
        theoretical,
        this.#capBasisStake,
        this.game.risk.maxWinMultiple,
        this.#liquidBalance,
      );
      const receipt = this.#makeReceipt(
        request.idempotencyKey,
        fingerprint,
        'sell',
        0n,
        result.credited,
        result.capped,
      );
      this.#position = undefined;
      this.#liquidBalance += result.credited;
      return receipt;
    });
  }

  async settle(request: SettleRequest): Promise<Receipt> {
    assertRequestRecord(request, 'SETTLE_REJECTED');
    assertIdempotencyKey(request.idempotencyKey);
    assertRevisionInput(request.expectedFrameRevision, '$.expectedFrameRevision');
    const revealedSeed = normalizeSeed(request.revealedSeed);
    const transcript = deserializeTranscript(request.transcript);
    const fingerprint = commandFingerprint('settle', [
      request.expectedFrameRevision,
      revealedSeed,
      serializeTranscript(transcript),
    ]);
    return this.#idempotent(request.idempotencyKey, fingerprint, () => {
      this.#assertFrame(request.expectedFrameRevision);
      if (this.#terminal) fail('SETTLE_REJECTED', 'Round is already terminal');
      if (this.#frameRevision !== this.game.evidence.eventCount)
        fail('SETTLE_REJECTED', 'Settlement requires the complete evidence schedule');
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
      const result =
        this.#capBasisStake === undefined
          ? { credited: 0n, capped: false }
          : payableWithinCap(
              theoretical,
              this.#capBasisStake,
              this.game.risk.maxWinMultiple,
              this.#liquidBalance,
            );
      const receipt = this.#makeReceipt(
        request.idempotencyKey,
        fingerprint,
        'settle',
        0n,
        result.credited,
        result.capped,
      );
      this.#terminal = true;
      this.#position = undefined;
      this.#liquidBalance += result.credited;
      return receipt;
    });
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }
  snapshot(): RoundBookSnapshot {
    const base = {
      schema: 'reveal-engine/round-book-v1' as const,
      adapter: Object.freeze({
        id: this.game.id,
        version: this.game.adapterVersion,
        fingerprint: adapterFingerprint(this.game),
      }),
      frameRevision: this.#frameRevision,
      ledgerRevision: this.#ledgerRevision,
      posterior: Object.freeze({
        weights: Object.freeze(this.#posterior.weights.map(String)),
        total: String(this.#posterior.total),
      }),
      evidence: Object.freeze(
        this.#evidence.map((event) =>
          Object.freeze({ ...event, favour: String(event.favour), other: String(event.other) }),
        ),
      ),
      position: this.#position
        ? Object.freeze({
            outcome: this.#position.outcome,
            contingentPayout: wireRational(this.#position.contingentPayout),
            stake: String(this.#position.stake),
            capBasisStake: String(this.#position.capBasisStake),
            entryCount: this.#position.entryCount,
            openedAtFrameRevision: this.#position.openedAtFrameRevision,
          })
        : null,
      entryCount: this.#entryCount,
      capBasisStake: this.#capBasisStake === undefined ? null : String(this.#capBasisStake),
      liquidBalance: String(this.#liquidBalance),
      terminal: this.#terminal,
      receipts: Object.freeze(
        [...this.#receipts.values()].map((stored) =>
          Object.freeze({ fingerprint: stored.fingerprint, receipt: wireReceipt(stored.receipt) }),
        ),
      ),
    };
    return Object.freeze({ ...base, snapshotHash: snapshotHash(base) });
  }

  static restore(game: GameDefinition, input: string | RoundBookSnapshot): RoundBook {
    const raw = parseSnapshotInput(input);
    if (
      raw.schema !== 'reveal-engine/round-book-v1' ||
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
        raw.posterior.weights.map((value) => parseBigInt(value, '$.posterior.weights')),
      ),
      total: parseBigInt(raw.posterior.total, '$.posterior.total'),
    });
    assertPosteriorForGame(posterior, game);
    const book = new RoundBook(game, posterior);
    book.#frameRevision = safeRevision(raw.frameRevision, '$.frameRevision');
    book.#evidence = raw.evidence.map((event, index) =>
      Object.freeze({
        index: event.index,
        target: event.target,
        favour: parseBigInt(event.favour, `$.evidence[${index}].favour`),
        other: parseBigInt(event.other, `$.evidence[${index}].other`),
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
    book.#ledgerRevision = safeRevision(raw.ledgerRevision, '$.ledgerRevision');
    book.#entryCount = safeRevision(raw.entryCount, '$.entryCount');
    book.#capBasisStake =
      raw.capBasisStake === null ? undefined : parseBigInt(raw.capBasisStake, '$.capBasisStake');
    book.#liquidBalance = parseBigInt(raw.liquidBalance, '$.liquidBalance', true);
    book.#terminal = raw.terminal;
    book.#position = raw.position
      ? Object.freeze({
          outcome: raw.position.outcome,
          contingentPayout: domainRational(raw.position.contingentPayout),
          stake: parseBigInt(raw.position.stake, '$.position.stake'),
          capBasisStake: parseBigInt(raw.position.capBasisStake, '$.position.capBasisStake'),
          entryCount: raw.position.entryCount,
          openedAtFrameRevision: raw.position.openedAtFrameRevision,
        })
      : undefined;
    let reconstructedLiquid = 0n;
    let openCount = 0;
    let activePosition = false;
    let settled = false;
    let firstStake: bigint | undefined;
    let lastOpenStake: bigint | undefined;
    const orderedReceipts = [...raw.receipts].sort(
      (left, right) => left.receipt.ledgerRevision - right.receipt.ledgerRevision,
    );
    for (const [index, stored] of orderedReceipts.entries()) {
      const receipt = domainReceipt(stored.receipt);
      if (
        receipt.ledgerRevision !== index + 1 ||
        receipt.frameRevision > book.#frameRevision ||
        stored.fingerprint !== receipt.commandFingerprint
      )
        fail('INVALID_SNAPSHOT', 'Receipt revisions are not canonical');
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
      book.#receipts.set(
        receipt.idempotencyKey,
        Object.freeze({ fingerprint: stored.fingerprint, receipt }),
      );
    }
    if (
      book.#receipts.size > ENGINE_LIMITS.maxEvidenceEvents ||
      book.#ledgerRevision !== book.#receipts.size ||
      book.#entryCount !== openCount ||
      book.#terminal !== settled ||
      Boolean(book.#position) !== activePosition ||
      (firstStake === undefined) !== (book.#capBasisStake === undefined) ||
      (firstStake !== undefined && firstStake !== book.#capBasisStake)
    )
      fail('INVALID_SNAPSHOT', 'Snapshot state invariants failed');
    if (reconstructedLiquid !== book.#liquidBalance || reconstructedLiquid < 0n)
      fail('INVALID_SNAPSHOT', 'Snapshot accounting does not conserve liquid value');
    if (
      book.#capBasisStake !== undefined &&
      book.#liquidBalance > book.#capBasisStake * game.risk.maxWinMultiple
    )
      fail('INVALID_SNAPSHOT', 'Snapshot exceeds the chain cap');
    if (
      book.#position &&
      (book.#position.outcome < 0 ||
        book.#position.outcome >= game.outcomes.length ||
        book.#position.capBasisStake !== book.#capBasisStake ||
        book.#position.entryCount !== openCount ||
        book.#position.stake !== lastOpenStake ||
        book.#position.openedAtFrameRevision > book.#frameRevision)
    )
      fail('INVALID_SNAPSHOT', 'Snapshot position is inconsistent');
    return book;
  }

  #assertFrame(expected: number): void {
    if (!Number.isSafeInteger(expected) || expected !== this.#frameRevision)
      fail('STALE_FRAME', 'Expected frame revision is stale', '$.expectedFrameRevision', {
        expected: this.#frameRevision,
        received: expected,
      });
  }
  #makeReceipt(
    key: string,
    fingerprint: string,
    action: Receipt['action'],
    debited: bigint,
    credited: bigint,
    capped: boolean,
  ): Receipt {
    return Object.freeze({
      schema: 'reveal-engine/receipt-v1',
      idempotencyKey: key,
      commandFingerprint: fingerprint,
      action,
      ledgerRevision: this.#ledgerRevision + 1,
      frameRevision: this.#frameRevision,
      debited,
      credited,
      balanceDelta: credited - debited,
      capped,
    });
  }
  async #idempotent(key: string, fingerprint: string, operation: () => Receipt): Promise<Receipt> {
    return this.#serial(() => {
      if (
        typeof key !== 'string' ||
        key.length === 0 ||
        Buffer.byteLength(key, 'utf8') > ENGINE_LIMITS.maxIdempotencyKeyBytes
      )
        fail('IDEMPOTENCY_CONFLICT', 'Invalid idempotency key', '$.idempotencyKey');
      const old = this.#receipts.get(key);
      if (old) {
        if (old.fingerprint !== fingerprint)
          fail(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key was used for a different command',
            '$.idempotencyKey',
          );
        return old.receipt;
      }
      if (this.#receipts.size >= ENGINE_LIMITS.maxEvidenceEvents)
        fail('IDEMPOTENCY_CONFLICT', 'Receipt limit reached');
      const receipt = operation();
      this.#ledgerRevision = receipt.ledgerRevision;
      this.#receipts.set(key, Object.freeze({ fingerprint, receipt }));
      return receipt;
    });
  }
  async #serial<T>(operation: () => T): Promise<T> {
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    const prior = this.#tail;
    this.#tail = gate;
    await prior;
    try {
      return operation();
    } finally {
      resolve();
    }
  }
}

function commandFingerprint(action: string, fields: readonly (string | number | bigint)[]): string {
  return createHash('sha256')
    .update(encodeFields(['round-command-v1', action, ...fields]))
    .digest('hex');
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
function wireRational(value: Rational): WireRational {
  return Object.freeze({
    numerator: String(value.numerator),
    denominator: String(value.denominator),
  });
}
function wireReceipt(receipt: Receipt): WireReceipt {
  return Object.freeze({
    ...receipt,
    debited: String(receipt.debited),
    credited: String(receipt.credited),
    balanceDelta: String(receipt.balanceDelta),
  });
}
function domainRational(value: WireRational): Rational {
  return rational(
    parseBigInt(value.numerator, '$.numerator', true),
    parseBigInt(value.denominator, '$.denominator'),
  );
}
function domainReceipt(value: WireReceipt): Receipt {
  const receipt = Object.freeze({
    ...value,
    debited: parseBigInt(value.debited, '$.receipt.debited', true),
    credited: parseBigInt(value.credited, '$.receipt.credited', true),
    balanceDelta: parseSignedBigInt(value.balanceDelta, '$.receipt.balanceDelta'),
  });
  if (
    receipt.schema !== 'reveal-engine/receipt-v1' ||
    !['open', 'sell', 'settle'].includes(receipt.action) ||
    receipt.balanceDelta !== receipt.credited - receipt.debited ||
    !/^[0-9a-f]{64}$/u.test(receipt.commandFingerprint) ||
    typeof receipt.idempotencyKey !== 'string' ||
    receipt.idempotencyKey.length === 0 ||
    Buffer.byteLength(receipt.idempotencyKey, 'utf8') > ENGINE_LIMITS.maxIdempotencyKeyBytes
  )
    fail('INVALID_SNAPSHOT', 'Snapshot receipt accounting is invalid');
  safeRevision(receipt.ledgerRevision, '$.receipt.ledgerRevision');
  safeRevision(receipt.frameRevision, '$.receipt.frameRevision');
  return receipt;
}
function parseBigInt(value: string, path: string, allowZero = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value))
    fail('INVALID_SNAPSHOT', 'Invalid canonical integer', path);
  const parsed = BigInt(value);
  if ((!allowZero && parsed <= 0n) || parsed.toString(2).length > ENGINE_LIMITS.maxBigIntBits)
    fail('INVALID_SNAPSHOT', 'Snapshot integer outside limits', path);
  return parsed;
}
function parseSignedBigInt(value: string, path: string): bigint {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/u.test(value) || value === '-0')
    fail('INVALID_SNAPSHOT', 'Invalid canonical signed integer', path);
  const parsed = BigInt(value);
  if ((parsed < 0n ? -parsed : parsed).toString(2).length > ENGINE_LIMITS.maxBigIntBits)
    fail('INVALID_SNAPSHOT', 'Snapshot integer outside limits', path);
  return parsed;
}
function safeRevision(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_SNAPSHOT', 'Invalid revision', path);
  return value;
}
function snapshotHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function parseSnapshotInput(input: string | RoundBookSnapshot): RoundBookSnapshot {
  let value: unknown = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > ENGINE_LIMITS.maxSnapshotBytes)
      fail('PAYLOAD_TOO_LARGE', 'Snapshot exceeds byte limit');
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      fail('INVALID_SNAPSHOT', 'Snapshot is not valid JSON');
    }
  }
  const candidate = snapshotRecord(value, '$');
  snapshotKeys(
    candidate,
    [
      'schema',
      'adapter',
      'frameRevision',
      'ledgerRevision',
      'posterior',
      'evidence',
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
  const adapter = snapshotRecord(candidate.adapter, '$.adapter');
  snapshotKeys(adapter, ['id', 'version', 'fingerprint'], '$.adapter');
  const posterior = snapshotRecord(candidate.posterior, '$.posterior');
  snapshotKeys(posterior, ['weights', 'total'], '$.posterior');
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
    const event = snapshotRecord(item, `$.evidence[${index}]`);
    snapshotKeys(event, ['index', 'target', 'favour', 'other', 'label'], `$.evidence[${index}]`);
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
  if (candidate.position !== null) {
    const position = snapshotRecord(candidate.position, '$.position');
    snapshotKeys(
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
    const contingentPayout = snapshotRecord(
      position.contingentPayout,
      '$.position.contingentPayout',
    );
    snapshotKeys(contingentPayout, ['numerator', 'denominator'], '$.position.contingentPayout');
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
  if (
    !Array.isArray(candidate.receipts) ||
    candidate.receipts.length > ENGINE_LIMITS.maxEvidenceEvents
  )
    fail('INVALID_SNAPSHOT', 'Receipts must be a bounded array', '$.receipts');
  candidate.receipts.forEach((item, index) => {
    const stored = snapshotRecord(item, `$.receipts[${index}]`);
    snapshotKeys(stored, ['fingerprint', 'receipt'], `$.receipts[${index}]`);
    assertHex(stored.fingerprint, `$.receipts[${index}].fingerprint`);
    const receipt = snapshotRecord(stored.receipt, `$.receipts[${index}].receipt`);
    snapshotKeys(
      receipt,
      [
        'schema',
        'idempotencyKey',
        'commandFingerprint',
        'action',
        'ledgerRevision',
        'frameRevision',
        'debited',
        'credited',
        'balanceDelta',
        'capped',
      ],
      `$.receipts[${index}].receipt`,
    );
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
    candidate.schema !== 'reveal-engine/round-book-v1' ||
    typeof adapter.id !== 'string' ||
    typeof adapter.version !== 'string' ||
    typeof candidate.terminal !== 'boolean' ||
    !Number.isSafeInteger(candidate.frameRevision) ||
    !Number.isSafeInteger(candidate.ledgerRevision) ||
    !Number.isSafeInteger(candidate.entryCount)
  )
    fail('INVALID_SNAPSHOT', 'Snapshot scalar fields are invalid');
  assertHex(adapter.fingerprint, '$.adapter.fingerprint');
  assertWireString(candidate.liquidBalance, '$.liquidBalance');
  if (candidate.capBasisStake !== null)
    assertWireString(candidate.capBasisStake, '$.capBasisStake');
  assertHex(candidate.snapshotHash, '$.snapshotHash');
  if (Buffer.byteLength(stableJson(candidate), 'utf8') > ENGINE_LIMITS.maxSnapshotBytes)
    fail('PAYLOAD_TOO_LARGE', 'Snapshot exceeds byte limit');
  return candidate as unknown as RoundBookSnapshot;
}

function snapshotRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_SNAPSHOT', 'Expected an object', path);
  return value as Record<string, unknown>;
}
function snapshotKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail('INVALID_SNAPSHOT', 'Object has missing or unknown fields', path);
}
function assertWireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1234)
    fail('INVALID_SNAPSHOT', 'Expected a bounded string', path);
}
function assertHex(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    fail('INVALID_SNAPSHOT', 'Expected canonical 32-byte hexadecimal', path);
}

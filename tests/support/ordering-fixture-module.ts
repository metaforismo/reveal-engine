/**
 * Test-only lifecycle module: evidence that `docs/lifecycle-modules.md` admits
 * shapes the progressive market does not have.
 *
 * - a structured truth (a permutation, not a scalar index);
 * - steps that drive an outcome's posterior to exactly zero;
 * - a `marginal` belief space: bets are priced over a combinatorial event space
 *   (`8!` orderings, a trifecta is one of 336 events) that cannot be expressed
 *   as a flat weight vector bounded by `ENGINE_LIMITS.maxOutcomes`;
 * - a multi-claim book whose several independently funded positions each grow
 *   the round's cap basis, settled against a paytable.
 *
 * It is deliberately not registered in `src/modules/index.ts` and is not a game.
 */
import { fail } from '../../src/api/errors.js';
import { countingProbability, factorial } from '../../src/core/combinatorics.js';
import { constantTimeHexEqual, sealCommitment } from '../../src/core/commitment.js';
import {
  CommandLedger,
  RECEIPT_WIRE_KEYS,
  commandFingerprint,
  fromWireReceipt,
  toWireReceipt,
  type Receipt as LedgerReceipt,
  type StoredReceipt,
  type WireReceipt,
} from '../../src/core/ledger.js';
import {
  assertClaimBudget,
  defineLifecycleModule,
  samplerScopeOf,
  type ConformanceFailure,
  type LifecycleModule,
  type LifecycleShape,
  type ModuleConformanceCheck,
  type RoundIdentity,
} from '../../src/core/module.js';
import { uniformPermutation } from '../../src/core/random.js';
import { add, divide, multiply, rational, type Rational } from '../../src/core/rational.js';
import {
  assertSnapshotKeys,
  assertSnapshotRecord,
  assertSnapshotSize,
  assertWireHex,
  assertWireString,
  parseSnapshotJson,
  parseWireBigInt,
  snapshotHash,
} from '../../src/core/snapshot.js';
import {
  classifyVerificationError,
  verificationFailure,
  verificationSuccess,
} from '../../src/core/verification.js';
import { COMMITMENT_VERSION, MODULE_API_VERSION } from '../../src/core/versions.js';
import { weightProbability, weightVector, type WeightVector } from '../../src/core/weights.js';
import { encodeFields, type CanonicalField } from '../../src/internal/canonical.js';

const MODULE_ID = 'ordering-fixture';
const MODULE_VERSION = '0.0.2';
const TRANSCRIPT_SCHEMA = 'ordering-fixture/transcript-v1' as const;
const SNAPSHOT_SCHEMA = 'ordering-fixture/book-v1' as const;
const ACTIONS = Object.freeze(['stake', 'settle'] as const);

export interface OrderingDefinition {
  readonly id: string;
  readonly version: string;
  readonly items: readonly string[];
  readonly rtp: Rational;
  readonly maxWinMultiple: bigint;
  readonly maxOpenBets: number;
}

export interface OrderingStep {
  readonly index: number;
  readonly position: number;
  readonly item: number;
}

/** A paytable bet over the ordering, not an index into a flat outcome vector. */
export type OrderingBet =
  | { readonly kind: 'win'; readonly items: readonly [number] }
  | { readonly kind: 'exacta'; readonly items: readonly [number, number] }
  | { readonly kind: 'trifecta'; readonly items: readonly [number, number, number] };

export interface OrderingTranscript {
  readonly schema: typeof TRANSCRIPT_SCHEMA;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly roundId: string;
  readonly truth: readonly number[];
  readonly steps: readonly OrderingStep[];
  readonly commitment: string;
}

export interface OrderingShape extends LifecycleShape {
  readonly definition: OrderingDefinition;
  readonly truth: readonly number[];
  readonly step: OrderingStep;
  readonly choice: never;
  readonly claim: OrderingBet;
  readonly transcript: OrderingTranscript;
  readonly book: OrderingBook;
}

function roundOf(definition: OrderingDefinition, roundId: string): RoundIdentity {
  return Object.freeze({
    moduleId: MODULE_ID,
    definitionId: definition.id,
    roundId,
    proofVersion: COMMITMENT_VERSION,
  });
}

function assertDefinition(value: unknown, path = '$'): asserts value is OrderingDefinition {
  const definition = value as OrderingDefinition;
  if (
    typeof definition !== 'object' ||
    definition === null ||
    typeof definition.id !== 'string' ||
    typeof definition.version !== 'string' ||
    !Array.isArray(definition.items) ||
    definition.items.length < 3 ||
    typeof definition.maxWinMultiple !== 'bigint' ||
    !Number.isSafeInteger(definition.maxOpenBets)
  )
    fail('INVALID_ADAPTER', 'Invalid ordering definition', path);
}

function identityFields(definition: OrderingDefinition): CanonicalField[] {
  return [
    MODULE_ID,
    definition.id,
    definition.version,
    definition.items.length,
    ...definition.items,
    definition.rtp.numerator,
    definition.rtp.denominator,
    definition.maxWinMultiple,
    definition.maxOpenBets,
  ];
}

function fingerprint(definition: OrderingDefinition): string {
  assertDefinition(definition);
  return sealCommitment('00'.repeat(32), encodeFields(identityFields(definition)));
}

/** A permutation truth: the whole finishing order, not a single index. */
function deriveTruth(seedHex: string, definition: OrderingDefinition, roundId: string): number[] {
  assertDefinition(definition);
  return [
    ...uniformPermutation(
      seedHex,
      samplerScopeOf(roundOf(definition, roundId)),
      'order',
      definition.items.length,
    ),
  ];
}

/** Reveals the trailing positions, eliminating each revealed item to exactly zero. */
function deriveSteps(definition: OrderingDefinition, truth: readonly number[]): OrderingStep[] {
  const steps: OrderingStep[] = [];
  for (let position = definition.items.length - 1; position >= 1; position -= 1)
    steps.push(Object.freeze({ index: steps.length, position, item: truth[position] as number }));
  return steps;
}

/**
 * Marginal belief: which item can still win.
 *
 * This is a display and elimination view, not the pricing space — see `price`.
 */
function belief(definition: OrderingDefinition, steps: readonly OrderingStep[]): WeightVector {
  const eliminated = new Set(steps.map((step) => step.item));
  return weightVector(definition.items.map((_item, index) => (eliminated.has(index) ? 0n : 1n)));
}

const BET_POSITIONS: Record<OrderingBet['kind'], number> = { win: 1, exacta: 2, trifecta: 3 };

function assertBet(definition: OrderingDefinition, bet: OrderingBet): void {
  const expected = BET_POSITIONS[bet?.kind];
  if (
    expected === undefined ||
    !Array.isArray(bet.items) ||
    bet.items.length !== expected ||
    bet.items.length > definition.items.length ||
    bet.items.some(
      (item) =>
        !Number.isSafeInteger(item) ||
        item < 0 ||
        item >= definition.items.length ||
        bet.items.indexOf(item) !== bet.items.lastIndexOf(item),
    )
  )
    fail('CLAIM_REJECTED', 'Invalid ordering bet', '$.bet');
}

/**
 * Exact probability of a bet over the orderings still consistent with the steps.
 *
 * `m` unrevealed positions can be filled `m!` ways. A bet fixes `k` of them; if
 * none of its requirements contradicts a reveal, exactly `(m - k)!` of those
 * orderings pay. Everything is exact BigInt counting — the pricing space is
 * combinatorial and is never flattened into a weight vector.
 */
function price(
  definition: OrderingDefinition,
  steps: readonly OrderingStep[],
  bet: OrderingBet,
): Rational {
  assertDefinition(definition);
  assertBet(definition, bet);
  const revealedItemAt = new Map<number, number>();
  const revealedPositionOf = new Map<number, number>();
  for (const step of steps) {
    revealedItemAt.set(step.position, step.item);
    revealedPositionOf.set(step.item, step.position);
  }
  const openPositions = definition.items.length - revealedItemAt.size;
  const support = factorial(openPositions);
  let consumed = 0;
  for (const [position, item] of bet.items.entries()) {
    const revealed = revealedItemAt.get(position);
    if (revealed !== undefined) {
      if (revealed !== item) return countingProbability(0n, support);
      continue;
    }
    if (revealedPositionOf.has(item)) return countingProbability(0n, support);
    consumed += 1;
  }
  return countingProbability(factorial(openPositions - consumed), support);
}

function commitmentBody(
  definition: OrderingDefinition,
  round: RoundIdentity,
  truth: readonly number[],
  steps: readonly OrderingStep[],
  choices: readonly never[],
): Buffer {
  if (choices.length !== 0) fail('INVALID_CHOICE', 'Ordering rounds log no choices', '$.choices');
  return encodeFields([
    'ordering-fixture commitment',
    COMMITMENT_VERSION,
    round.moduleId,
    ...identityFields(definition),
    fingerprint(definition),
    round.roundId,
    truth.length,
    ...truth,
    steps.length,
    ...steps.flatMap((step): CanonicalField[] => [step.index, step.position, step.item]),
  ]);
}

function build(
  seedHex: string,
  definition: OrderingDefinition,
  roundId: string,
): OrderingTranscript {
  assertDefinition(definition);
  const round = roundOf(definition, roundId);
  const truth = deriveTruth(seedHex, definition, roundId);
  const steps = deriveSteps(definition, truth);
  return Object.freeze({
    schema: TRANSCRIPT_SCHEMA,
    definitionId: definition.id,
    definitionVersion: definition.version,
    roundId,
    truth: Object.freeze(truth),
    steps: Object.freeze(steps),
    commitment: sealCommitment(seedHex, commitmentBody(definition, round, truth, steps, [])),
  });
}

function fromWire(input: unknown): OrderingTranscript {
  const value = input as OrderingTranscript;
  if (
    typeof value !== 'object' ||
    value === null ||
    value.schema !== TRANSCRIPT_SCHEMA ||
    typeof value.roundId !== 'string' ||
    !Array.isArray(value.truth) ||
    !Array.isArray(value.steps) ||
    typeof value.commitment !== 'string'
  )
    fail('INVALID_TRANSCRIPT', 'Invalid ordering transcript', '$.schema');
  return value;
}

export interface OrderingClaim {
  readonly key: string;
  readonly bet: OrderingBet;
  readonly stake: bigint;
  readonly payout: Rational;
}

export interface OrderingSnapshot {
  readonly schema: typeof SNAPSHOT_SCHEMA;
  readonly definition: { readonly id: string; readonly fingerprint: string };
  readonly terminal: boolean;
  readonly ledgerRevision: number;
  readonly stepRevision: number;
  readonly liquidBalance: string;
  readonly capBasisStake: string | null;
  readonly claims: readonly {
    readonly key: string;
    readonly kind: OrderingBet['kind'];
    readonly items: readonly number[];
    readonly stake: string;
    readonly payout: { readonly numerator: string; readonly denominator: string };
  }[];
  readonly receipts: readonly { readonly fingerprint: string; readonly receipt: WireReceipt }[];
  readonly snapshotHash: string;
}

/**
 * Multi-claim book: several simultaneous, independently funded bets settled
 * against one paytable from one shared ledger.
 */
export class OrderingBook {
  readonly #ledger: CommandLedger;
  readonly #claims = new Map<string, OrderingClaim>();
  #stepRevision = 0;
  #terminal = false;

  constructor(readonly definition: OrderingDefinition) {
    assertDefinition(definition);
    this.#ledger = new CommandLedger({ maxWinMultiple: definition.maxWinMultiple });
  }

  get claims(): readonly OrderingClaim[] {
    return Object.freeze([...this.#claims.values()]);
  }
  get liquidBalance(): bigint {
    return this.#ledger.liquidBalance;
  }
  get capBasisStake(): bigint | undefined {
    return this.#ledger.capBasisStake;
  }
  get terminal(): boolean {
    return this.#terminal;
  }

  async stake(
    key: string,
    bet: OrderingBet,
    amount: bigint,
    steps: readonly OrderingStep[],
  ): Promise<LedgerReceipt<'stake' | 'settle'>> {
    assertBet(this.definition, bet);
    const fp = commandFingerprint('stake', [bet.kind, ...bet.items, amount]);
    return this.#ledger.execute(key, fp, () => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is terminal');
      assertClaimBudget(this.#claims.size, this.definition.maxOpenBets);
      const probability = price(this.definition, steps, bet);
      if (probability.numerator === 0n)
        fail('CLAIM_REJECTED', 'Bet has posterior exactly zero', '$.bet');
      const payout = multiply(rational(amount), divide(this.definition.rtp, probability));
      const receipt = this.#ledger.mint(key, fp, 'stake', steps.length, amount, 0n, false);
      // Each bet is separately funded, so each one raises the round's ceiling.
      this.#ledger.fundStake(amount, 'external');
      this.#stepRevision = Math.max(this.#stepRevision, steps.length);
      this.#claims.set(key, Object.freeze({ key, bet, stake: amount, payout }));
      return receipt;
    });
  }

  async settle(
    key: string,
    transcript: OrderingTranscript,
  ): Promise<LedgerReceipt<'stake' | 'settle'>> {
    const fp = commandFingerprint('settle', [transcript.commitment]);
    return this.#ledger.execute(key, fp, () => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is already terminal');
      const total = this.claims
        .filter((claim) => betWins(claim.bet, transcript.truth))
        .reduce((sum, claim) => add(sum, claim.payout), rational(0n));
      const result =
        this.#ledger.capBasisStake === undefined
          ? Object.freeze({ theoretical: total, credited: 0n, capped: false })
          : this.#ledger.creditWithinCap(total);
      const receipt = this.#ledger.mint(
        key,
        fp,
        'settle',
        transcript.steps.length,
        0n,
        result.credited,
        result.capped,
      );
      this.#terminal = true;
      this.#stepRevision = Math.max(this.#stepRevision, transcript.steps.length);
      this.#ledger.applyCredit(result.credited);
      return receipt;
    });
  }

  snapshot(): OrderingSnapshot {
    const capBasisStake = this.#ledger.capBasisStake;
    const base = {
      schema: SNAPSHOT_SCHEMA,
      definition: Object.freeze({
        id: this.definition.id,
        fingerprint: fingerprint(this.definition),
      }),
      terminal: this.#terminal,
      ledgerRevision: this.#ledger.ledgerRevision,
      stepRevision: this.#stepRevision,
      liquidBalance: String(this.#ledger.liquidBalance),
      capBasisStake: capBasisStake === undefined ? null : String(capBasisStake),
      claims: Object.freeze(
        this.claims.map((claim) =>
          Object.freeze({
            key: claim.key,
            kind: claim.bet.kind,
            items: Object.freeze([...claim.bet.items]),
            stake: String(claim.stake),
            payout: Object.freeze({
              numerator: String(claim.payout.numerator),
              denominator: String(claim.payout.denominator),
            }),
          }),
        ),
      ),
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
   * Re-validates rather than trusts: hash, definition identity, receipt log
   * replayed through the shared ledger, and a reconciled balance.
   */
  static restore(definition: OrderingDefinition, input: string | object): OrderingBook {
    assertDefinition(definition);
    const raw = parseOrderingSnapshot(input);
    if (raw.snapshotHash !== snapshotHash({ ...raw, snapshotHash: undefined }))
      fail('INVALID_SNAPSHOT', 'Snapshot hash is invalid', '$.snapshotHash');
    if (
      raw.definition.id !== definition.id ||
      raw.definition.fingerprint !== fingerprint(definition)
    )
      fail('DEFINITION_MISMATCH', 'Snapshot belongs to another definition', '$.definition');
    const book = new OrderingBook(definition);
    book.#terminal = raw.terminal;
    book.#stepRevision = raw.stepRevision;
    for (const claim of raw.claims) {
      const bet = { kind: claim.kind, items: [...claim.items] } as unknown as OrderingBet;
      assertBet(definition, bet);
      book.#claims.set(
        claim.key,
        Object.freeze({
          key: claim.key,
          bet,
          stake: parseWireBigInt(claim.stake, '$.claims[].stake'),
          payout: rational(
            parseWireBigInt(claim.payout.numerator, '$.claims[].payout.numerator', true),
            parseWireBigInt(claim.payout.denominator, '$.claims[].payout.denominator'),
          ),
        }),
      );
    }
    if (book.#claims.size !== raw.claims.length)
      fail('INVALID_SNAPSHOT', 'Snapshot claim keys are not unique', '$.claims');
    if (book.#claims.size > definition.maxOpenBets)
      fail('INVALID_SNAPSHOT', 'Snapshot exceeds the declared claim budget', '$.claims');

    let reconstructedLiquid = 0n;
    let stakedTotal = 0n;
    let stakes = 0;
    let settled = false;
    const stored: StoredReceipt<'stake' | 'settle'>[] = raw.receipts.map((entry) => ({
      fingerprint: entry.fingerprint,
      receipt: fromWireReceipt<'stake' | 'settle'>(entry.receipt, ACTIONS),
    }));
    book.#ledger.install(stored, book.#stepRevision, (receipt) => {
      if (receipt.action === 'stake') {
        if (settled || receipt.debited <= 0n || receipt.credited !== 0n)
          fail('INVALID_SNAPSHOT', 'Receipt sequence violates the round state machine');
        // The receipt fingerprint pins the bet and the stake, so a rewritten
        // claim list cannot survive its own receipt log.
        const claim = raw.claims[stakes];
        if (
          claim === undefined ||
          receipt.idempotencyKey !== claim.key ||
          receipt.commandFingerprint !==
            commandFingerprint('stake', [
              claim.kind,
              ...claim.items,
              parseWireBigInt(claim.stake, '$.claims[].stake'),
            ])
        )
          fail('INVALID_SNAPSHOT', 'Receipt does not match the restored claim', '$.claims');
        stakedTotal += receipt.debited;
        stakes += 1;
      } else {
        if (settled || receipt.debited !== 0n)
          fail('INVALID_SNAPSHOT', 'Receipt sequence violates the round state machine');
        reconstructedLiquid += receipt.credited;
        settled = true;
      }
    });
    const capBasisStake =
      raw.capBasisStake === null
        ? undefined
        : parseWireBigInt(raw.capBasisStake, '$.capBasisStake');
    if (
      stakes !== book.#claims.size ||
      settled !== book.#terminal ||
      (stakes === 0) !== (capBasisStake === undefined) ||
      (capBasisStake !== undefined && capBasisStake !== stakedTotal)
    )
      fail('INVALID_SNAPSHOT', 'Snapshot state invariants failed');
    if (reconstructedLiquid !== parseWireBigInt(raw.liquidBalance, '$.liquidBalance', true))
      fail('INVALID_SNAPSHOT', 'Snapshot accounting does not conserve liquid value');
    book.#ledger.restoreBalances({
      ledgerRevision: raw.ledgerRevision,
      liquidBalance: reconstructedLiquid,
      capBasisStake,
    });
    return book;
  }
}

function betWins(bet: OrderingBet, truth: readonly number[]): boolean {
  return bet.items.every((item, position) => truth[position] === item);
}

function parseOrderingSnapshot(input: string | object): OrderingSnapshot {
  const value: unknown = typeof input === 'string' ? parseSnapshotJson(input) : input;
  const candidate = assertSnapshotRecord(value, '$');
  assertSnapshotKeys(
    candidate,
    [
      'schema',
      'definition',
      'terminal',
      'ledgerRevision',
      'stepRevision',
      'liquidBalance',
      'capBasisStake',
      'claims',
      'receipts',
      'snapshotHash',
    ],
    '$',
  );
  if (
    candidate.schema !== SNAPSHOT_SCHEMA ||
    typeof candidate.terminal !== 'boolean' ||
    !Number.isSafeInteger(candidate.ledgerRevision) ||
    !Number.isSafeInteger(candidate.stepRevision) ||
    !Array.isArray(candidate.claims) ||
    !Array.isArray(candidate.receipts)
  )
    fail('INVALID_SNAPSHOT', 'Snapshot scalar fields are invalid', '$');
  const definition = assertSnapshotRecord(candidate.definition, '$.definition');
  assertSnapshotKeys(definition, ['id', 'fingerprint'], '$.definition');
  assertWireString(definition.id, '$.definition.id');
  assertWireHex(definition.fingerprint, '$.definition.fingerprint');
  assertWireString(candidate.liquidBalance, '$.liquidBalance');
  if (candidate.capBasisStake !== null)
    assertWireString(candidate.capBasisStake, '$.capBasisStake');
  candidate.claims.forEach((item, index) => {
    const claim = assertSnapshotRecord(item, `$.claims[${index}]`);
    assertSnapshotKeys(claim, ['key', 'kind', 'items', 'stake', 'payout'], `$.claims[${index}]`);
    assertWireString(claim.key, `$.claims[${index}].key`);
    assertWireString(claim.kind, `$.claims[${index}].kind`);
    assertWireString(claim.stake, `$.claims[${index}].stake`);
    if (!Array.isArray(claim.items))
      fail('INVALID_SNAPSHOT', 'Bet items must be an array', `$.claims[${index}].items`);
    const payout = assertSnapshotRecord(claim.payout, `$.claims[${index}].payout`);
    assertSnapshotKeys(payout, ['numerator', 'denominator'], `$.claims[${index}].payout`);
    assertWireString(payout.numerator, `$.claims[${index}].payout.numerator`);
    assertWireString(payout.denominator, `$.claims[${index}].payout.denominator`);
  });
  candidate.receipts.forEach((item, index) => {
    const entry = assertSnapshotRecord(item, `$.receipts[${index}]`);
    assertSnapshotKeys(entry, ['fingerprint', 'receipt'], `$.receipts[${index}]`);
    assertWireHex(entry.fingerprint, `$.receipts[${index}].fingerprint`);
    const receipt = assertSnapshotRecord(entry.receipt, `$.receipts[${index}].receipt`);
    assertSnapshotKeys(receipt, RECEIPT_WIRE_KEYS, `$.receipts[${index}].receipt`);
  });
  assertWireHex(candidate.snapshotHash, '$.snapshotHash');
  assertSnapshotSize(candidate);
  return candidate as unknown as OrderingSnapshot;
}

const truthIsPermutation: ModuleConformanceCheck<OrderingShape> = {
  code: 'TRUTH_IS_PERMUTATION',
  description: 'Derived truth is a permutation of the declared items',
  scope: 'round',
  run({ definition, seedHex, roundId, count }): readonly ConformanceFailure[] {
    const truth = deriveTruth(seedHex, definition, roundId);
    count('truths');
    const sorted = [...truth].sort((a, b) => a - b);
    return sorted.every((value, index) => value === index)
      ? []
      : [{ code: 'TRUTH_IS_PERMUTATION', path: '$.truth', message: 'Truth is not a permutation' }];
  },
};

const eliminationIsExact: ModuleConformanceCheck<OrderingShape> = {
  code: 'ELIMINATION_NOT_EXACT',
  description: 'Every revealed item reaches posterior exactly zero',
  scope: 'round',
  run({ definition, seedHex, roundId, count }): readonly ConformanceFailure[] {
    const transcript = build(seedHex, definition, roundId);
    count('transcripts');
    const failures: ConformanceFailure[] = [];
    for (let prefix = 1; prefix <= transcript.steps.length; prefix += 1) {
      const steps = transcript.steps.slice(0, prefix);
      const weights = belief(definition, steps);
      for (const step of steps)
        if (weightProbability(weights, step.item).numerator !== 0n)
          failures.push({
            code: 'ELIMINATION_NOT_EXACT',
            path: '$.steps',
            message: `Item ${step.item} kept non-zero mass after reveal`,
          });
    }
    return failures;
  },
};

const priceIsAProbability: ModuleConformanceCheck<OrderingShape> = {
  code: 'PRICE_NOT_NORMALISED',
  description: 'Win prices over the whole field sum to exactly one at every step prefix',
  scope: 'round',
  run({ definition, seedHex, roundId, count }): readonly ConformanceFailure[] {
    const transcript = build(seedHex, definition, roundId);
    const failures: ConformanceFailure[] = [];
    for (let prefix = 0; prefix <= transcript.steps.length; prefix += 1) {
      const steps = transcript.steps.slice(0, prefix);
      const total = definition.items.reduce(
        (sum, _item, index) => add(sum, price(definition, steps, { kind: 'win', items: [index] })),
        rational(0n),
      );
      count('priceSweeps');
      if (total.numerator !== total.denominator)
        failures.push({
          code: 'PRICE_NOT_NORMALISED',
          path: '$.price',
          message: `Win prices summed to ${total.numerator}/${total.denominator} after ${prefix} steps`,
        });
    }
    return failures;
  },
};

/**
 * `defineLifecycleModule()` cannot tell whether `restore()` re-validates or just
 * returns a fresh book — both satisfy the type. Conformance can: a restore that
 * ignores its input accepts a tampered snapshot, and this check refuses to pass
 * a module whose restore does.
 *
 * Checks are synchronous, so this covers the codec and the tamper posture; the
 * staked and settled round trip is covered by an async test.
 */
const snapshotIsRevalidated: ModuleConformanceCheck<OrderingShape> = {
  code: 'SNAPSHOT_NOT_REVALIDATED',
  description: 'restore() round-trips its own snapshot and rejects tampered ones',
  scope: 'round',
  run({ definition, count }): readonly ConformanceFailure[] {
    const snapshot = new OrderingBook(definition).snapshot();
    count('snapshots');
    const failures: ConformanceFailure[] = [];
    const reject = (message: string): void => {
      failures.push({ code: 'SNAPSHOT_NOT_REVALIDATED', path: '$.snapshot', message });
    };
    try {
      const restored = OrderingBook.restore(definition, JSON.stringify(snapshot));
      if (JSON.stringify(restored.snapshot()) !== JSON.stringify(snapshot))
        reject('Restored book does not re-serialize identically');
    } catch (error) {
      reject(`Restore rejected its own snapshot: ${String(error)}`);
    }
    const tampers: readonly Record<string, unknown>[] = [
      { ...snapshot, liquidBalance: '999999' },
      { ...snapshot, ledgerRevision: 7 },
      { ...snapshot, definition: { ...snapshot.definition, fingerprint: '0'.repeat(64) } },
      { ...snapshot, snapshotHash: '0'.repeat(64) },
    ];
    for (const tampered of tampers) {
      count('snapshotTampers');
      try {
        OrderingBook.restore(definition, JSON.stringify(tampered));
        reject('Restore accepted a tampered snapshot');
      } catch {
        // Expected: a tampered snapshot must not restore.
      }
    }
    return failures;
  },
};

export const orderingFixtureDefinition: OrderingDefinition = Object.freeze({
  id: 'ordering-fixture-v1',
  version: '1.0.0',
  items: Object.freeze(['alpha', 'beta', 'gamma', 'delta']),
  rtp: rational(97n, 100n),
  maxWinMultiple: 1000n,
  maxOpenBets: 8,
});

/**
 * Eight items: `8!` = 40,320 orderings and 336 trifectas, both far beyond
 * `ENGINE_LIMITS.maxOutcomes`. The definition exists to prove the contract
 * prices a combinatorial paytable exactly, without a flat weight vector.
 */
export const orderingFixtureLargeDefinition: OrderingDefinition = Object.freeze({
  id: 'ordering-fixture-large-v1',
  version: '1.0.0',
  items: Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
  rtp: rational(97n, 100n),
  maxWinMultiple: 10_000n,
  maxOpenBets: 16,
});

export const orderingFixtureModule: LifecycleModule<OrderingShape> =
  defineLifecycleModule<OrderingShape>({
    moduleApiVersion: MODULE_API_VERSION,
    id: MODULE_ID,
    version: MODULE_VERSION,
    summary:
      'Test-only contract fixture: permutation truth, zero-elimination steps, combinatorial paytable, multi-claim book.',
    definitions: {
      define: (input) => Object.freeze({ ...input, items: Object.freeze([...input.items]) }),
      assert: assertDefinition,
      fingerprint,
      identity: (definition) =>
        Object.freeze({
          moduleId: MODULE_ID,
          moduleVersion: MODULE_VERSION,
          definitionId: definition.id,
          definitionVersion: definition.version,
          fingerprint: fingerprint(definition),
        }),
    },
    truth: {
      kind: 'permutation',
      derive: deriveTruth,
      encode: (truth) => [truth.length, ...truth],
      equal: (left, right) =>
        left.length === right.length && left.every((value, index) => value === right[index]),
    },
    steps: {
      maxSteps: 64,
      choiceTiming: 'none',
      beliefSpace: 'marginal',
      count: (definition) => definition.items.length - 1,
      derive: (_seedHex, definition, _round, truth) => deriveSteps(definition, truth),
      encode: (step) => [step.index, step.position, step.item],
      equal: (left, right) =>
        left.length === right.length &&
        left.every(
          (step, index) =>
            step.index === right[index]?.index &&
            step.position === right[index]?.position &&
            step.item === right[index]?.item,
        ),
      belief,
      price,
    },
    transcript: {
      schema: TRANSCRIPT_SCHEMA,
      acceptedSchemas: [TRANSCRIPT_SCHEMA],
      build,
      commitmentBody,
      toWire: (transcript) => ({ ...transcript }),
      fromWire,
    },
    book: {
      snapshotSchema: SNAPSHOT_SCHEMA,
      positions: 'multi',
      settlement: 'paytable',
      maxOpenClaims: 16,
      actions: ACTIONS,
      create: (definition) => new OrderingBook(definition),
      restore: (definition, snapshot) => OrderingBook.restore(definition, snapshot),
      snapshot: (book) => book.snapshot(),
    },
    conformance: {
      defaultSeeds: 4,
      checks: [truthIsPermutation, eliminationIsExact, priceIsAProbability, snapshotIsRevalidated],
      references: [
        { id: orderingFixtureDefinition.id, definition: orderingFixtureDefinition },
        { id: orderingFixtureLargeDefinition.id, definition: orderingFixtureLargeDefinition },
      ],
    },
    verify(seedHex, definition, input) {
      try {
        assertDefinition(definition);
        const transcript = fromWire(input);
        if (
          transcript.definitionId !== definition.id ||
          transcript.definitionVersion !== definition.version
        )
          return verificationFailure(
            'DEFINITION_MISMATCH',
            'Transcript definition does not match verifier',
            '$.definitionId',
          );
        const expected = build(seedHex, definition, transcript.roundId);
        if (!orderingFixtureModule.truth.equal(expected.truth, transcript.truth))
          return verificationFailure('TRANSCRIPT_MISMATCH', 'Truth differs', '$.truth');
        if (!orderingFixtureModule.steps.equal(expected.steps, transcript.steps))
          return verificationFailure('TRANSCRIPT_MISMATCH', 'Steps differ', '$.steps');
        if (!constantTimeHexEqual(expected.commitment, transcript.commitment))
          return verificationFailure(
            'COMMITMENT_MISMATCH',
            'Commitment does not match revealed seed',
            '$.commitment',
          );
        return verificationSuccess(COMMITMENT_VERSION, expected.commitment);
      } catch (error) {
        return classifyVerificationError(error);
      }
    },
  });

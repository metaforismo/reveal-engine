/**
 * Test-only lifecycle module used as evidence that `docs/lifecycle-modules.md`
 * admits shapes the progressive market does not have:
 *
 * - a structured truth (a permutation, not a scalar index);
 * - steps that drive an outcome's posterior to exactly zero;
 * - a multi-claim book settled against a paytable rather than one position.
 *
 * It is deliberately not registered in `src/modules/index.ts` and is not a game.
 */
import { sealCommitment } from '../../src/core/commitment.js';
import {
  CommandLedger,
  commandFingerprint,
  type Receipt as LedgerReceipt,
} from '../../src/core/ledger.js';
import {
  defineLifecycleModule,
  type ConformanceFailure,
  type LifecycleModule,
  type LifecycleShape,
  type ModuleConformanceCheck,
  type RoundIdentity,
} from '../../src/core/module.js';
import { uniformPermutation, type SamplerScope } from '../../src/core/random.js';
import { divide, multiply, rational, type Rational } from '../../src/core/rational.js';
import {
  classifyVerificationError,
  verificationFailure,
  verificationSuccess,
} from '../../src/core/verification.js';
import { COMMITMENT_VERSION, MODULE_API_VERSION } from '../../src/core/versions.js';
import { weightProbability, weightVector, type WeightVector } from '../../src/core/weights.js';
import { encodeFields, type CanonicalField } from '../../src/internal/canonical.js';
import { fail } from '../../src/api/errors.js';

export interface OrderingDefinition {
  readonly id: string;
  readonly version: string;
  readonly items: readonly string[];
  readonly rtp: Rational;
  readonly maxWinMultiple: bigint;
}

export interface OrderingStep {
  readonly index: number;
  readonly position: number;
  readonly item: number;
}

export interface OrderingTranscript {
  readonly schema: 'ordering-fixture/transcript-v1';
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
  readonly transcript: OrderingTranscript;
  readonly book: OrderingBook;
}

const TRANSCRIPT_SCHEMA = 'ordering-fixture/transcript-v1' as const;
const SNAPSHOT_SCHEMA = 'ordering-fixture/book-v1' as const;
const ACTIONS = Object.freeze(['stake', 'settle'] as const);

function scopeOf(round: RoundIdentity): SamplerScope {
  return {
    domain: round.definitionId,
    roundId: round.roundId,
    proofVersion: round.proofVersion,
  };
}

function roundOf(definition: OrderingDefinition, roundId: string): RoundIdentity {
  return Object.freeze({
    moduleId: 'ordering-fixture',
    definitionId: definition.id,
    roundId,
    proofVersion: COMMITMENT_VERSION,
  });
}

function assertDefinition(value: unknown): asserts value is OrderingDefinition {
  const definition = value as OrderingDefinition;
  if (
    typeof definition !== 'object' ||
    definition === null ||
    typeof definition.id !== 'string' ||
    !Array.isArray(definition.items) ||
    definition.items.length < 2
  )
    fail('INVALID_ADAPTER', 'Invalid ordering definition');
}

function fingerprint(definition: OrderingDefinition): string {
  return sealCommitment('00'.repeat(32), encodeFields(identityFields(definition)));
}

function identityFields(definition: OrderingDefinition): CanonicalField[] {
  return [
    'ordering-fixture',
    definition.id,
    definition.version,
    definition.items.length,
    ...definition.items,
    definition.rtp.numerator,
    definition.rtp.denominator,
    definition.maxWinMultiple,
  ];
}

/** A permutation truth: the whole finishing order, not a single index. */
function deriveTruth(seedHex: string, definition: OrderingDefinition, roundId: string): number[] {
  return [
    ...uniformPermutation(
      seedHex,
      scopeOf(roundOf(definition, roundId)),
      'order',
      definition.items.length,
    ),
  ];
}

/** Reveals the trailing positions, eliminating each revealed item to exactly zero. */
function deriveSteps(definition: OrderingDefinition, truth: readonly number[]): OrderingStep[] {
  const steps: OrderingStep[] = [];
  for (let position = definition.items.length - 1; position >= 1; position -= 1)
    steps.push(
      Object.freeze({
        index: steps.length,
        position,
        item: truth[position] as number,
      }),
    );
  return steps;
}

function belief(definition: OrderingDefinition, steps: readonly OrderingStep[]): WeightVector {
  const eliminated = new Set(steps.map((step) => step.item));
  return weightVector(definition.items.map((_item, index) => (eliminated.has(index) ? 0n : 1n)));
}

function commitmentBody(
  definition: OrderingDefinition,
  round: RoundIdentity,
  truth: readonly number[],
  steps: readonly OrderingStep[],
): Buffer {
  return encodeFields([
    'ordering-fixture commitment',
    COMMITMENT_VERSION,
    ...identityFields(definition),
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
    commitment: sealCommitment(seedHex, commitmentBody(definition, round, truth, steps)),
  });
}

function fromWire(input: unknown): OrderingTranscript {
  const value = input as OrderingTranscript;
  if (
    typeof value !== 'object' ||
    value === null ||
    value.schema !== TRANSCRIPT_SCHEMA ||
    !Array.isArray(value.truth) ||
    !Array.isArray(value.steps) ||
    typeof value.commitment !== 'string'
  )
    fail('INVALID_TRANSCRIPT', 'Invalid ordering transcript', '$.schema');
  return value;
}

export interface OrderingClaim {
  readonly item: number;
  readonly stake: bigint;
  readonly payout: Rational;
}

/** Multi-claim book: several simultaneous positions settled against one paytable. */
export class OrderingBook {
  readonly #ledger: CommandLedger;
  readonly #claims = new Map<string, OrderingClaim>();
  #terminal = false;

  constructor(readonly definition: OrderingDefinition) {
    this.#ledger = new CommandLedger({ maxWinMultiple: definition.maxWinMultiple });
  }

  get claims(): readonly OrderingClaim[] {
    return [...this.#claims.values()];
  }
  get liquidBalance(): bigint {
    return this.#ledger.liquidBalance;
  }
  get terminal(): boolean {
    return this.#terminal;
  }

  async stake(
    key: string,
    item: number,
    amount: bigint,
    steps: readonly OrderingStep[],
  ): Promise<LedgerReceipt<'stake' | 'settle'>> {
    const fp = commandFingerprint('stake', [item, amount]);
    return this.#ledger.execute(key, fp, () => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is terminal');
      if (this.#claims.has(key)) fail('OPEN_REJECTED', 'Claim already exists');
      const probability = weightProbability(belief(this.definition, steps), item);
      if (probability.numerator === 0n)
        fail('OPEN_REJECTED', 'Outcome has posterior exactly zero', '$.item');
      const payout = multiply(rational(amount), divide(this.definition.rtp, probability));
      const receipt = this.#ledger.mint(key, fp, 'stake', steps.length, amount, 0n, false);
      this.#claims.set(key, Object.freeze({ item, stake: amount, payout }));
      this.#ledger.adoptCapBasis(amount);
      return receipt;
    });
  }

  async settle(
    key: string,
    transcript: OrderingTranscript,
  ): Promise<LedgerReceipt<'stake' | 'settle'>> {
    const fp = commandFingerprint('settle', [transcript.commitment]);
    return this.#ledger.execute(key, fp, () => {
      if (this.#terminal) fail('SETTLE_REJECTED', 'Round is already terminal');
      const winner = transcript.truth[0];
      const total = this.claims
        .filter((claim) => claim.item === winner)
        .reduce(
          (sum, claim) => multiply(rational(1n), addRational(sum, claim.payout)),
          rational(0n),
        );
      const result = this.#ledger.creditWithinCap(total);
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
      this.#ledger.applyCredit(result.credited);
      return receipt;
    });
  }

  snapshot(): object {
    return {
      schema: SNAPSHOT_SCHEMA,
      definitionId: this.definition.id,
      terminal: this.#terminal,
      liquidBalance: String(this.#ledger.liquidBalance),
      claims: [...this.#claims.entries()].map(([key, claim]) => ({
        key,
        item: claim.item,
        stake: String(claim.stake),
        payout: {
          numerator: String(claim.payout.numerator),
          denominator: String(claim.payout.denominator),
        },
      })),
    };
  }
}

function addRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
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

export const orderingFixtureModule: LifecycleModule<OrderingShape> =
  defineLifecycleModule<OrderingShape>({
    moduleApiVersion: MODULE_API_VERSION,
    id: 'ordering-fixture',
    version: '0.0.1',
    summary:
      'Test-only contract fixture: permutation truth, zero-elimination steps, multi-claim book.',
    definitions: {
      define: (input) => Object.freeze({ ...input, items: Object.freeze([...input.items]) }),
      assert: assertDefinition,
      fingerprint,
      identity: (definition) =>
        Object.freeze({
          moduleId: 'ordering-fixture',
          moduleVersion: '0.0.1',
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
      actions: ACTIONS,
      create: (definition) => new OrderingBook(definition),
      restore: (definition) => new OrderingBook(definition),
      snapshot: (book) => book.snapshot(),
    },
    conformance: {
      defaultSeeds: 4,
      checks: [truthIsPermutation, eliminationIsExact],
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
            'ADAPTER_MISMATCH',
            'Transcript definition does not match verifier',
            '$.definitionId',
          );
        const expected = build(seedHex, definition, transcript.roundId);
        if (!orderingFixtureModule.truth.equal(expected.truth, transcript.truth))
          return verificationFailure('TRANSCRIPT_MISMATCH', 'Truth differs', '$.truth');
        if (!orderingFixtureModule.steps.equal(expected.steps, transcript.steps))
          return verificationFailure('TRANSCRIPT_MISMATCH', 'Steps differ', '$.steps');
        if (expected.commitment !== transcript.commitment)
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

export const orderingFixtureDefinition: OrderingDefinition = Object.freeze({
  id: 'ordering-fixture-v1',
  version: '1.0.0',
  items: Object.freeze(['alpha', 'beta', 'gamma', 'delta']),
  rtp: rational(97n, 100n),
  maxWinMultiple: 1000n,
});

import { describe, expect, it } from 'vitest';
import { add, equal, multiply, rational, subtract, type Rational } from '../src/core/rational.js';
import { payableWithinCap } from '../src/core/payments.js';
import {
  SurvivalBook,
  deriveSteps,
  deriveTruth,
  distributionTotal,
  defineSurvivalGame,
  lanePartition,
  resolveStage,
  roundRefId,
  survivorDistribution,
  oracleTrialReference,
  type SurvivalChoice,
  type SurvivalDefinition,
  type SurvivalStep,
} from '../src/modules/staged-survival/index.js';
import { survivalAdmission } from './support/survival-admission.js';

/**
 * The mandatory oracle: a three-entity, two-stage instance enumerated
 * exhaustively against an independently coded model.
 *
 * The model below is written from the module's *documentation*, not from its
 * code: it restates the adapter's numbers as literals, builds its own lane
 * partition, and enumerates the elementary events of a stage — one shared shock
 * per lane, then one independent clear per entity — directly. The only thing it
 * shares with the module is exact `Rational` arithmetic, which is core and is
 * the point of the exercise rather than the subject of it.
 *
 * Three properties are proved here, all by enumeration and all exact:
 *
 * 1. **Resolution.** For every contract, every reachable field, and every one of
 *    the `2^(lanes + entities)` elementary draw patterns, the module's resolver
 *    produces exactly the model's survivor set. This is the whole event space,
 *    not a sample.
 * 2. **Pricing.** The module's survivor distribution equals the model's, term
 *    for term, and sums to exactly `1`.
 * 3. **Money.** Every contract path — and every banking policy over it — has
 *    expected total claim value exactly equal to the entry value, claim value is
 *    conserved across a partial bank, and the round cap is never exceeded and
 *    binds exactly where the arithmetic says it must.
 */

const MODULUS = 12n;
const ENTITIES = 3;
const ENTRY_RETURN = rational(9n, 10n);
const ONE = rational(1n);

interface OracleContract {
  readonly id: string;
  readonly laneWidth: number;
  readonly minEntities: number;
  /** `q`: the shared per-lane shock. */
  readonly laneFailure: Rational;
  /** `c`: the independent per-entity clear. */
  readonly entitySurvival: Rational;
  readonly multiplier: Rational;
}

/** The oracle instance, restated as literals so the model is genuinely a second source. */
const ORACLE_CONTRACTS: readonly OracleContract[] = [
  {
    id: 'pair',
    laneWidth: 2,
    minEntities: 1,
    laneFailure: rational(1n, 3n),
    entitySurvival: rational(3n, 4n),
    multiplier: rational(2n, 1n),
  },
  {
    id: 'solo',
    laneWidth: 1,
    minEntities: 1,
    laneFailure: rational(0n, 1n),
    entitySurvival: rational(2n, 3n),
    multiplier: rational(3n, 2n),
  },
];

const contractOf = (id: string): OracleContract =>
  ORACLE_CONTRACTS.find((contract) => contract.id === id) as OracleContract;

/** Independent lane partition: consecutive blocks of `laneWidth`, remainder last. */
function modelLanes(contract: OracleContract, live: readonly number[]): number[][] {
  const lanes: number[][] = [];
  let index = 0;
  while (index < live.length) {
    lanes.push(live.slice(index, index + contract.laneWidth));
    index += contract.laneWidth;
  }
  return lanes;
}

interface ModelEvent {
  readonly collapsed: readonly boolean[];
  /** Per entity of the field, whether its own clear draw succeeded. */
  readonly cleared: ReadonlyMap<number, boolean>;
  readonly survivors: readonly number[];
  readonly failed: readonly number[];
  readonly probability: Rational;
}

/** Every elementary event of one stage, with its exact probability. */
function modelStage(contract: OracleContract, live: readonly number[]): ModelEvent[] {
  const q = contract.laneFailure;
  const held = subtract(ONE, q);
  const c = contract.entitySurvival;
  const missed = subtract(ONE, c);
  let events: ModelEvent[] = [
    {
      collapsed: [],
      cleared: new Map(),
      survivors: [],
      failed: [],
      probability: ONE,
    },
  ];
  for (const lane of modelLanes(contract, live)) {
    const next: ModelEvent[] = [];
    for (const event of events) {
      if (q.numerator > 0n)
        next.push({
          collapsed: [...event.collapsed, true],
          // A collapsed lane never consults its entity draws; the model records
          // them as "missed" so the pattern is total and the two sides can be
          // compared draw for draw.
          cleared: new Map([...event.cleared, ...lane.map((entity) => [entity, false] as const)]),
          survivors: [...event.survivors],
          failed: [...event.failed, ...lane],
          probability: multiply(event.probability, q),
        });
      if (held.numerator === 0n) continue;
      for (let mask = 0; mask < 1 << lane.length; mask += 1) {
        let probability = multiply(event.probability, held);
        const cleared = new Map(event.cleared);
        const survivors = [...event.survivors];
        const failed = [...event.failed];
        lane.forEach((entity, position) => {
          const clears = ((mask >> position) & 1) === 1;
          probability = multiply(probability, clears ? c : missed);
          cleared.set(entity, clears);
          (clears ? survivors : failed).push(entity);
        });
        if (probability.numerator === 0n) continue;
        next.push({
          collapsed: [...event.collapsed, false],
          cleared,
          survivors,
          failed,
          probability,
        });
      }
    }
    events = next;
  }
  return events.map((event) => ({
    ...event,
    survivors: [...event.survivors].sort((left, right) => left - right),
    failed: [...event.failed].sort((left, right) => left - right),
  }));
}

/** Every non-empty subset of `[0, ENTITIES)`, ascending. */
function subsets(size: number): number[][] {
  const all: number[][] = [];
  for (let mask = 1; mask < 1 << size; mask += 1)
    all.push(
      Array.from({ length: size }, (_entity, index) => index).filter(
        (index) => ((mask >> index) & 1) === 1,
      ),
    );
  return all;
}

/**
 * The draw value that makes an event fire, or not fire, under its threshold.
 *
 * `0` is below every positive threshold and `M-1` is below none that is under
 * `M`, so these two values realise any event the model gave positive
 * probability. Asking for one it did not is a bug in the enumeration, and it
 * throws here rather than silently testing a different pattern.
 */
function drawFor(fire: boolean, threshold: bigint): bigint {
  if (fire && threshold <= 0n) throw new Error('cannot realise a probability-zero event');
  if (!fire && threshold >= MODULUS) throw new Error('cannot avoid a probability-one event');
  return fire ? 0n : MODULUS - 1n;
}

const thresholdOf = (value: Rational): bigint => value.numerator * (MODULUS / value.denominator);

describe('staged-survival oracle: three entities, two stages, enumerated exhaustively', () => {
  it('pins the shipped reference to the numbers the model restates', () => {
    expect(oracleTrialReference.entities).toBe(ENTITIES);
    expect(oracleTrialReference.stages).toBe(2);
    expect(oracleTrialReference.drawModulus).toBe(MODULUS);
    expect(oracleTrialReference.pricing.entryReturn).toEqual(ENTRY_RETURN);
    expect(oracleTrialReference.contracts.map((contract) => contract.id)).toEqual(
      ORACLE_CONTRACTS.map((contract) => contract.id),
    );
    for (const contract of oracleTrialReference.contracts) {
      const model = contractOf(contract.id);
      expect(contract.laneWidth).toBe(model.laneWidth);
      expect(contract.minEntities).toBe(model.minEntities);
      expect(contract.profile.laneFailure).toEqual(model.laneFailure);
      expect(contract.profile.entitySurvival).toEqual(model.entitySurvival);
      expect(contract.multiplier).toEqual(model.multiplier);
    }
  });

  it('resolves every elementary draw pattern exactly as the independent model does', () => {
    let patterns = 0;
    for (const model of ORACLE_CONTRACTS)
      for (const live of subsets(ENTITIES)) {
        const laneThreshold = thresholdOf(model.laneFailure);
        const entityThreshold = thresholdOf(model.entitySurvival);
        // The lane partition itself is compared before anything is resolved.
        const declared = lanePartition(
          oracleTrialReference.contracts.find(
            (candidate) => candidate.id === model.id,
          ) as SurvivalDefinition['contracts'][number],
          live,
        );
        expect(declared.map((lane) => [...lane])).toEqual(modelLanes(model, live));

        for (const event of modelStage(model, live)) {
          patterns += 1;
          const resolution = resolveStage(
            oracleTrialReference,
            model.id,
            live,
            (laneIndex) => drawFor(event.collapsed[laneIndex] as boolean, laneThreshold),
            (entity) => drawFor(event.cleared.get(entity) as boolean, entityThreshold),
          );
          expect([...resolution.survivors]).toEqual([...event.survivors]);
          expect([...resolution.failed]).toEqual([...event.failed]);
          expect(resolution.lanes.map((lane) => lane.collapsed)).toEqual([...event.collapsed]);
          // A collapsed lane takes every entity in it, with no exceptions.
          for (const lane of resolution.lanes)
            if (lane.collapsed)
              for (const entity of lane.entities)
                expect(resolution.survivors).not.toContain(entity);
        }
      }
    // Every elementary event of every reachable field, counted independently.
    //
    // `pair` has a positive shock, so a lane of size `s` contributes `1 + 2^s`
    // events (collapse, or hold and then each entity's own clear): fields of
    // 1, 2 and 3 give 3, 5 and 15, over three, three and one subsets = 39.
    // `solo` declares `q` exactly zero, so the collapse branch has probability
    // zero and does not exist: a field of `n` contributes `2^n`, giving
    // 3*2 + 3*4 + 8 = 26. The total is the whole event space, and nothing else.
    expect(patterns).toBe(39 + 26);
  });

  it('prices the survivor distribution exactly, term for term, and sums to one', () => {
    for (const model of ORACLE_CONTRACTS) {
      const contract = oracleTrialReference.contracts.find(
        (candidate) => candidate.id === model.id,
      ) as SurvivalDefinition['contracts'][number];
      for (let live = 1; live <= ENTITIES; live += 1) {
        const field = Array.from({ length: live }, (_entity, index) => index);
        const expected = Array.from({ length: live + 1 }, () => rational(0n));
        for (const event of modelStage(model, field))
          expected[event.survivors.length] = add(
            expected[event.survivors.length] as Rational,
            event.probability,
          );
        const actual = survivorDistribution(oracleTrialReference, contract, live);
        expect(actual.length).toBe(expected.length);
        actual.forEach((share, survivors) =>
          expect(equal(share, expected[survivors] as Rational)).toBe(true),
        );
        expect(equal(distributionTotal(actual), ONE)).toBe(true);
        // The marginal is unmoved by the geometry: exactly `n * (1 - q) * c`.
        const mean = actual.reduce(
          (total, share, survivors) => add(total, multiply(rational(BigInt(survivors)), share)),
          rational(0n),
        );
        expect(
          equal(
            mean,
            multiply(
              rational(BigInt(live)),
              multiply(subtract(ONE, model.laneFailure), model.entitySurvival),
            ),
          ),
        ).toBe(true);
      }
    }
  });

  it('carries value forward exactly for every contract and every reachable field', () => {
    // `sum_k P(k) * k * mu == n` for every geometry: the statement that a stage
    // is a martingale on claim value, read through the joint law rather than
    // through the marginal it was built from.
    for (const model of ORACLE_CONTRACTS)
      for (const live of subsets(ENTITIES)) {
        let carried = rational(0n);
        for (const event of modelStage(model, live))
          carried = add(
            carried,
            multiply(
              event.probability,
              multiply(rational(BigInt(event.survivors.length)), model.multiplier),
            ),
          );
        expect(equal(carried, rational(BigInt(live.length)))).toBe(true);
      }
  });

  /** Exact expected total claim value of a whole two-stage policy, by enumeration. */
  function expectedRoundValue(
    firstId: string,
    secondId: string,
    bank: (survivors: readonly number[]) => readonly number[],
    stake: bigint,
  ): { readonly banked: Rational; readonly settled: Rational } {
    const first = contractOf(firstId);
    const second = contractOf(secondId);
    const field = Array.from({ length: ENTITIES }, (_entity, index) => index);
    const unit = multiply(rational(stake), ENTRY_RETURN);
    let banked = rational(0n);
    let settled = rational(0n);
    for (const stageOne of modelStage(first, field)) {
      const afterOne = multiply(unit, first.multiplier);
      const survivors = stageOne.survivors;
      const withdrawn = bank(survivors);
      banked = add(
        banked,
        multiply(stageOne.probability, multiply(rational(BigInt(withdrawn.length)), afterOne)),
      );
      const running = survivors.filter((entity) => !withdrawn.includes(entity));
      if (running.length === 0) continue;
      for (const stageTwo of modelStage(second, running))
        settled = add(
          settled,
          multiply(
            multiply(stageOne.probability, stageTwo.probability),
            multiply(
              rational(BigInt(stageTwo.survivors.length)),
              multiply(afterOne, second.multiplier),
            ),
          ),
        );
    }
    return { banked, settled };
  }

  it('gives every contract path and every banking policy the same exact expected value', () => {
    const stake = 1_000n;
    const entryValue = multiply(rational(stake * BigInt(ENTITIES)), ENTRY_RETURN);
    const policies: readonly [string, (survivors: readonly number[]) => readonly number[]][] = [
      ['bank nothing', () => []],
      ['bank everything', (survivors) => survivors],
      ['bank the lowest', (survivors) => survivors.slice(0, 1)],
      ['bank all but the lowest', (survivors) => survivors.slice(1)],
    ];
    let paths = 0;
    for (const first of ORACLE_CONTRACTS)
      for (const second of ORACLE_CONTRACTS)
        for (const [label, bank] of policies) {
          const { banked, settled } = expectedRoundValue(first.id, second.id, bank, stake);
          paths += 1;
          // Conservation: what is banked plus what is settled is exactly the
          // entry value, for every route and every policy. Correlation moves
          // the variance of this number and never its mean.
          expect(
            equal(add(banked, settled), entryValue),
            `${first.id} -> ${second.id}, ${label}`,
          ).toBe(true);
        }
    expect(paths).toBe(16);
  });

  it('replays a seeded round through the same resolver the oracle enumerated', () => {
    const seedHex = '5c'.repeat(32);
    const roundId = roundRefId({ roundId: 'oracle-replay', clientEntropy: '7e'.repeat(32) });
    const truth = deriveTruth(seedHex, oracleTrialReference, roundId);
    expect(truth.draws).toHaveLength(2 * 2 * ENTITIES * 2);
    const choices: SurvivalChoice[] = [
      { contractId: 'pair', banked: [] },
      { contractId: 'solo', banked: [] },
    ];
    const steps = deriveSteps(oracleTrialReference, truth, choices);
    // Every step is exactly what the resolver produces from the draws the tape
    // holds at the documented addresses, which is what ties the enumeration
    // above to a real seeded round.
    steps.forEach((step, stage) => {
      const contractIndex = oracleTrialReference.contracts.findIndex(
        (contract) => contract.id === step.contractId,
      );
      const base = (stage * oracleTrialReference.contracts.length + contractIndex) * ENTITIES * 2;
      const field = stage === 0 ? [0, 1, 2] : [...(steps[stage - 1] as SurvivalStep).survivors];
      const replay = resolveStage(
        oracleTrialReference,
        step.contractId,
        field,
        (laneIndex) => (truth.draws[base + laneIndex] as { value: bigint }).value,
        (entity) => (truth.draws[base + ENTITIES + entity] as { value: bigint }).value,
      );
      expect([...replay.survivors]).toEqual([...step.survivors]);
      expect([...replay.failed]).toEqual([...step.failed]);
    });
  });

  /**
   * The same instance with a ceiling the arithmetic can reach.
   *
   * `entryReturn * maxMultiple^stages = 9/10 * 4 = 18/5`, so a `maxWinMultiple`
   * of `2` is reachable and `capMustBeUnreachable` is declared `false` — which
   * is the honest declaration, and the one that lets the cap be exercised.
   */
  const cappedTrial: SurvivalDefinition = defineSurvivalGame({
    ...oracleTrialReference,
    id: 'oracle-trial-capped-v1',
    risk: {
      maxWinMultiple: 2n,
      capBasis: 'round-external-stake',
      capMustBeUnreachable: false,
    },
  });

  it('holds the round ceiling across the whole chain and binds exactly where it must', async () => {
    const stake = 1_000n;
    const basis = stake * BigInt(ENTITIES);
    const ceiling = basis * cappedTrial.risk.maxWinMultiple;
    const pair = contractOf('pair');
    let capped = 0;
    let runs = 0;

    // The whole two-stage event space, ridden to the end and banked in full:
    // every reachable credit of this configuration, not a sampled one.
    for (const stageOne of modelStage(pair, [0, 1, 2])) {
      const survivors = stageOne.survivors;
      const stageTwoEvents: (ModelEvent | undefined)[] =
        survivors.length === 0 ? [undefined] : modelStage(pair, survivors);
      for (const stageTwo of stageTwoEvents) {
        const oracleRound = roundRefId({
          roundId: 'oracle-cap-sweep',
          clientEntropy: '11'.repeat(32),
        });
        const book = new SurvivalBook(
          cappedTrial,
          survivalAdmission(cappedTrial, '01'.repeat(32), oracleRound),
        );
        for (let entity = 0; entity < ENTITIES; entity += 1)
          await book.enter(`enter-${entity}`, entity, stake);
        await book.choose('choose-0', 'pair');
        await book.resolve(stepFor(cappedTrial, 'pair', [0, 1, 2], 0, stageOne));
        runs += 1;
        if (stageTwo === undefined) {
          expect(book.live).toEqual([]);
          expect(book.liquidBalance).toBe(0n);
          continue;
        }
        await book.choose('choose-1', 'pair');
        await book.resolve(stepFor(cappedTrial, 'pair', survivors, 1, stageTwo));
        if (book.live.length > 0) {
          const receipt = await book.bank('bank-all', [...book.live]);
          if (receipt.capped) capped += 1;
        }
        expect(book.liquidBalance).toBeLessThanOrEqual(ceiling);
        expect(SurvivalBook.restore(cappedTrial, book.snapshot()).liquidBalance).toBe(
          book.liquidBalance,
        );
      }
    }
    // Counted from the model rather than asserted, then pinned: the sweep is
    // every stage-one event followed by every stage-two event of the field it
    // left behind — 4 wipes, 6 one-survivor, 4 two-survivor and 1 clean sweep,
    // continued into 1, 3, 5 and 15 second stages respectively.
    const expectedRuns = modelStage(pair, [0, 1, 2]).reduce(
      (total, event) =>
        total + (event.survivors.length === 0 ? 1 : modelStage(pair, event.survivors).length),
      0,
    );
    expect(runs).toBe(expectedRuns);
    expect(runs).toBe(57);
    // The bound is not decorative here: at least one enumerated path pays the
    // ceiling and stops, rather than paying what the ladder alone would owe.
    expect(capped).toBeGreaterThan(0);
  });

  it('applies the cap once across a chain of partial banks, never per bank', async () => {
    const stake = 1_000n;
    const basis = stake * BigInt(ENTITIES);
    const ceiling = basis * cappedTrial.risk.maxWinMultiple;
    const pair = contractOf('pair');
    // The elementary event where nothing collapses and everything clears: the
    // maximum-value branch, which is where a forgotten `applyCredit` would show.
    const allClear = modelStage(pair, [0, 1, 2]).find(
      (event) => event.survivors.length === ENTITIES,
    ) as ModelEvent;

    const oracleRound = roundRefId({
      roundId: 'oracle-cap-chain',
      clientEntropy: '22'.repeat(32),
    });
    const book = new SurvivalBook(
      cappedTrial,
      survivalAdmission(cappedTrial, '02'.repeat(32), oracleRound),
    );
    for (let entity = 0; entity < ENTITIES; entity += 1)
      await book.enter(`enter-${entity}`, entity, stake);
    await book.choose('choose-0', 'pair');
    await book.resolve(stepFor(cappedTrial, 'pair', [0, 1, 2], 0, allClear));
    await book.choose('choose-1', 'pair');
    await book.resolve(stepFor(cappedTrial, 'pair', [0, 1, 2], 1, allClear));

    // Value per entity after two `pair` stages: 1000 * 9/10 * 2 * 2 = 3600.
    const perEntity = multiply(
      multiply(rational(stake), ENTRY_RETURN),
      multiply(pair.multiplier, pair.multiplier),
    );
    expect(equal(perEntity, rational(3_600n))).toBe(true);

    let liquid = 0n;
    for (const entity of [0, 1, 2]) {
      const expectedPayable = payableWithinCap(
        perEntity,
        basis,
        cappedTrial.risk.maxWinMultiple,
        liquid,
      );
      const receipt = await book.bank(`bank-${entity}`, [entity]);
      expect(receipt.credited).toBe(expectedPayable.credited);
      expect(receipt.capped).toBe(expectedPayable.capped);
      liquid += receipt.credited;
      expect(book.liquidBalance).toBe(liquid);
      expect(book.liquidBalance).toBeLessThanOrEqual(ceiling);
    }
    // Three uncapped banks would have paid 10,800 against a 6,000 ceiling.
    expect(liquid).toBe(ceiling);
    expect(SurvivalBook.restore(cappedTrial, book.snapshot()).liquidBalance).toBe(ceiling);
  });
});

/** Builds the step a resolver would produce for one enumerated elementary event. */
function stepFor(
  definition: SurvivalDefinition,
  contractId: string,
  field: readonly number[],
  index: number,
  event: ModelEvent,
): SurvivalStep {
  const model = contractOf(contractId);
  const laneThreshold = thresholdOf(model.laneFailure);
  const entityThreshold = thresholdOf(model.entitySurvival);
  const resolution = resolveStage(
    definition,
    contractId,
    field,
    (laneIndex) => drawFor(event.collapsed[laneIndex] as boolean, laneThreshold),
    (entity) => drawFor(event.cleared.get(entity) as boolean, entityThreshold),
  );
  return Object.freeze({
    index,
    contractId,
    banked: Object.freeze([]),
    lanes: resolution.lanes,
    survivors: resolution.survivors,
    failed: resolution.failed,
  });
}

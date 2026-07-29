import { describe, expect, it } from 'vitest';
import { rational } from '../../src/core/rational.js';
import { ENGINE_API_VERSION } from '../../src/core/versions.js';
import {
  CARDS_MAX_ANALYSIS_CELLS,
  CARDS_MAX_ANALYSIS_OPS,
  analyseDefinition,
  estimateAnalysisCells,
  estimateAnalysisWork,
  forEachCanonicalState,
} from '../../src/modules/sequential-cards/analysis.js';
import { defineCardsGame } from '../../src/modules/sequential-cards/adapter.js';
import {
  SEQUENTIAL_CARDS_MODULE_ID,
  type CardsAction,
  type SequentialCardsDefinition,
} from '../../src/modules/sequential-cards/contracts.js';
import {
  cascadeMiddleReference,
  duoMiddleReference,
  triadMiddleReference,
} from '../../src/modules/sequential-cards/references.js';

/**
 * The definition-time budget has to bound the work it says it bounds.
 *
 * Round two's estimate had a term for the walk's cells and **no term at all**
 * for `cardsBelief`, whose inner loop is `C(|pool|, m)` per distinct belief.
 * That cost dominates whenever the deck is much wider than the hand, so the
 * estimate under-predicted the real work on a whole axis, and the ns-per-op rate
 * published from one shape did not hold on any other. Two independent things
 * went wrong and both are pinned here: the arithmetic of the bound, and the
 * promptness of the refusal.
 *
 * Nothing here is a timing assertion except the refusal, which is bounded so
 * generously that it can only fail if a refusal starts walking again.
 */

interface Shape {
  readonly label: string;
  readonly size: number;
  readonly dealt: number;
  readonly reveals?: number;
  readonly width?: number;
  readonly actions?: readonly CardsAction[];
}

function draft(shape: Shape): SequentialCardsDefinition {
  return {
    apiVersion: ENGINE_API_VERSION,
    moduleId: SEQUENTIAL_CARDS_MODULE_ID,
    id: `bound-${shape.label}`,
    version: '1.0.0',
    ladder: { size: shape.size, dealt: shape.dealt, objective: 'middle' },
    reveal: {
      modelVersion: 'bound/v1',
      count: shape.reveals ?? 1,
      eligibility: 'unbacked',
      sortRemaining: true,
    },
    backing: { maxOpenBeforeReveal: shape.width ?? 1, rebackMode: 'move' },
    sideMarkets: [],
    ticket: { requiresBackedMarket: true, stakeScope: 'per-selection' },
    pricing: {
      entryRtp: rational(24n, 25n),
      liquidationSpread: rational(0n),
      rounding: 'floor',
      minStakeCredits: 500_000n,
      stakeStepCredits: 500_000n,
      actions: shape.actions ?? ['switch', 'cash'],
      splitMode: 'even',
    },
    risk: { maxWinMultiple: 10_000_000n, capMustNotBind: false },
    seed: { operatorSeedScope: 'per-round', clientEntropy: 'required', clientSeedBytes: 16 },
  } as unknown as SequentialCardsDefinition;
}

/**
 * The completions the walk really enumerates.
 *
 * `runAnalysis` memoises `cardsBelief` on the revealed `(position, rank)`
 * prefix, and `forEachCanonicalState` walks the identical tree, so summing
 * `belief.completions` once per distinct prefix reproduces the belief cost
 * exactly rather than modelling it.
 */
function realisedCompletions(definition: SequentialCardsDefinition): bigint {
  const seen = new Map<string, bigint>();
  forEachCanonicalState(definition, ({ steps, belief }) => {
    const key = steps.map((step) => `${step.position}:${step.rank}`).join('|');
    if (!seen.has(key)) seen.set(key, belief.completions);
  });
  let total = 0n;
  for (const completions of seen.values()) total += completions;
  return total;
}

/** Small enough to walk in a test, and spread across both axes of the bound. */
const SHAPES: readonly Shape[] = Object.freeze([
  { label: 'narrow-deck-split', size: 13, dealt: 3, actions: ['switch', 'split', 'cash'] },
  { label: 'no-split', size: 13, dealt: 3 },
  { label: 'two-backed', size: 9, dealt: 5, width: 2 },
  { label: 'two-reveals', size: 9, dealt: 5, reveals: 2, actions: ['switch', 'split', 'cash'] },
  { label: 'wide-deck', size: 24, dealt: 3 },
  { label: 'wide-deck-split', size: 20, dealt: 3, actions: ['switch', 'split', 'cash'] },
  { label: 'wider-hand', size: 11, dealt: 5 },
  { label: 'widest-hand', size: 9, dealt: 7 },
]);

describe('the definition-time work estimate is an upper bound', () => {
  // Every case here walks a whole definition twice — once for its cells and once
  // for its beliefs — so the budget is generous by design. None of it is a
  // timing assertion; the only one of those is the refusal, below.
  const subjects: readonly (readonly [string, SequentialCardsDefinition])[] = [
    ['triad-middle-v1', triadMiddleReference],
    ['duo-middle-v1', duoMiddleReference],
    ['cascade-middle-v1', cascadeMiddleReference],
    ...SHAPES.map(
      (shape) => [shape.label, draft(shape)] as readonly [string, SequentialCardsDefinition],
    ),
  ];

  it.each(subjects)('dominates the realised cells and completions of %s', (_label, definition) => {
    const cells = BigInt(analyseDefinition(definition).cells);
    const completions = realisedCompletions(definition);

    // The cell bound is the tight one: it is what makes a refusal cheap, so it
    // has to be close as well as correct.
    expect(estimateAnalysisCells(definition)).toBeGreaterThanOrEqual(cells);

    // And the work bound covers both cost centres. One completion is counted as
    // one operation, which over-weights it — a completion is an integer merge,
    // an operation is a BigInt multiply and a GCD — so this comparison is the
    // conservative direction on the axis that was missing entirely.
    expect(estimateAnalysisWork(definition)).toBeGreaterThanOrEqual(cells + completions);
  });

  /**
   * The regression itself, stated as the inequality that used to fail.
   *
   * At `size 24 / dealt 3` the belief enumeration is the larger of the two cost
   * centres. An estimate built only from the cell walk — which is what round two
   * shipped — is therefore below the real work however its per-cell factor is
   * chosen, because the missing term is not a constant multiple of the term that
   * was there.
   */
  it('makes the belief enumeration the dominant term where it really is', () => {
    const definition = draft({ label: 'wide-deck-dominance', size: 24, dealt: 3 });
    const cells = BigInt(analyseDefinition(definition).cells);
    const completions = realisedCompletions(definition);

    expect(completions).toBeGreaterThan(cells);
    expect(estimateAnalysisWork(definition) - estimateAnalysisCells(definition)).toBeGreaterThan(
      completions,
    );
  });

  /** The cell bound is exact where the reveal tree does not branch a cover set. */
  it('reproduces the realised cell count exactly on both single-reveal references', () => {
    for (const reference of [triadMiddleReference, duoMiddleReference])
      expect(estimateAnalysisCells(reference)).toBe(BigInt(analyseDefinition(reference).cells));
  });

  it('leaves every shipped reference inside both ceilings', () => {
    for (const reference of [triadMiddleReference, duoMiddleReference, cascadeMiddleReference]) {
      expect(estimateAnalysisWork(reference)).toBeLessThan(CARDS_MAX_ANALYSIS_OPS);
      expect(estimateAnalysisCells(reference)).toBeLessThan(BigInt(CARDS_MAX_ANALYSIS_CELLS));
    }
  });
});

describe('a definition over either ceiling is refused before the walk', () => {
  /**
   * `size 30 / dealt 5` is the shape that used to cost 33 seconds to refuse.
   *
   * Round two's operations bound admitted it and the cell budget then fired from
   * inside `budget()`, after the walk had counted three million cells — the
   * exact "blocked event loop before the refusal arrives" condition the
   * operations bound was introduced to remove and did not, because it was
   * closed from the declaration and the cell budget was not. Both are closed
   * from the declaration now, and the cell bound is checked first because it is
   * the tighter of the two.
   */
  it('refuses a wide reveal tree on the cell ceiling, immediately', () => {
    const definition = draft({ label: 'oversized-cells', size: 30, dealt: 5 });
    expect(estimateAnalysisCells(definition)).toBeGreaterThan(BigInt(CARDS_MAX_ANALYSIS_CELLS));

    const started = process.hrtime.bigint();
    expect(() => analyseDefinition(definition)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_ADAPTER',
        details: expect.objectContaining({ reason: 'ANALYSIS_SPACE_TOO_LARGE' }),
      }),
    );
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1_000);
  });

  /**
   * And a shape can be under the cell ceiling and far over the operations one.
   *
   * `size 9 / dealt 7` with `split` holds 485,604 cells — inside the cell
   * ceiling — but every post-reveal cell offers 63 controls and
   * `identicalPairs` compares every pair of them, so the same walk is 334M
   * operations. This is the axis the cell budget has never been able to see, and
   * it is why there are two ceilings rather than one.
   */
  it('refuses an expensive cell on the operations ceiling, immediately', () => {
    const definition = draft({
      label: 'oversized-ops',
      size: 9,
      dealt: 7,
      reveals: 2,
      actions: ['switch', 'split', 'cash'],
    });
    expect(estimateAnalysisCells(definition)).toBeLessThan(BigInt(CARDS_MAX_ANALYSIS_CELLS));
    expect(estimateAnalysisWork(definition)).toBeGreaterThan(CARDS_MAX_ANALYSIS_OPS);

    const started = process.hrtime.bigint();
    expect(() => analyseDefinition(definition)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_ADAPTER',
        details: expect.objectContaining({ reason: 'ANALYSIS_SPACE_TOO_LARGE' }),
      }),
    );
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1_000);
  });

  /**
   * The refusal reaches an operator through `defineCardsGame`, with a message
   * that names which ceiling it hit rather than only that one was hit.
   */
  it('names the ceiling it exceeded', () => {
    expect(() =>
      defineCardsGame(draft({ label: 'oversized-message', size: 30, dealt: 5 })),
    ).toThrowError(/reachable \(state, cover\) cells/);
    expect(() =>
      defineCardsGame(
        draft({
          label: 'oversized-ops-message',
          size: 9,
          dealt: 7,
          reveals: 2,
          actions: ['switch', 'split', 'cash'],
        }),
      ),
    ).toThrowError(/exact-rational operations/);
  });
});

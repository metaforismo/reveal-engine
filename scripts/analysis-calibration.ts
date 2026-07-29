/**
 * Calibrates `CARDS_MAX_ANALYSIS_OPS` and `CARDS_MAX_ANALYSIS_CELLS` against
 * measured wall time, on both axes, and prints the table
 * `docs/modules/sequential-cards.md` §11 publishes.
 *
 * Round two calibrated the operations ceiling on a single shape — `size 13 /
 * dealt 7` — and published the resulting rate as if it held everywhere. It does
 * not: the estimate's looseness is shape-dependent by nearly three orders of
 * magnitude, and ns-per-estimated-operation is exactly its reciprocal. A ceiling
 * has to be set from the **worst** rate, on the shape where the bound is
 * tightest, because that is the shape that converts the whole ceiling into wall
 * time. This script measures that spread rather than assuming it away.
 *
 * The probes deliberately span both axes and are not all admissible: the ones
 * that are refused are here to show *where* the ceilings sit, and the harness
 * reports a refusal with the time it took to arrive, which is the other half of
 * the property (a refusal must be immediate, not a walk that gives up).
 *
 *   node --import tsx scripts/analysis-calibration.ts
 *
 * Timings are a single sample on one machine and vary by roughly ±2x with
 * machine state and Node build; the reproducible part is the estimate, the
 * realised cell count, and their ratio. Only the derived ceiling is a claim.
 */
import {
  CARDS_MAX_ANALYSIS_CELLS,
  CARDS_MAX_ANALYSIS_OPS,
  analyseDefinition,
  estimateAnalysisCells,
  estimateAnalysisWork,
} from '../src/modules/sequential-cards/analysis.js';
import {
  SEQUENTIAL_CARDS_MODULE_ID,
  type CardsAction,
  type SequentialCardsDefinition,
} from '../src/modules/sequential-cards/contracts.js';
import { SEQUENTIAL_CARDS_REFERENCES } from '../src/modules/sequential-cards/references.js';
import { rational } from '../src/core/rational.js';
import { ENGINE_API_VERSION } from '../src/core/versions.js';

interface Probe {
  readonly label: string;
  readonly size: number;
  readonly dealt: number;
  readonly reveals?: number;
  readonly width?: number;
  readonly actions?: readonly CardsAction[];
}

/** Probes chosen to straddle both axes the bound has to cover. */
const PROBES: readonly Probe[] = Object.freeze([
  { label: 'size 13 / dealt 3 / split', size: 13, dealt: 3, actions: ['switch', 'split', 'cash'] },
  { label: 'size 9 / dealt 5 / width 2', size: 9, dealt: 5, width: 2 },
  {
    label: 'size 9 / dealt 5 / 2 reveals / split',
    size: 9,
    dealt: 5,
    reveals: 2,
    actions: ['switch', 'split', 'cash'],
  },
  { label: 'size 13 / dealt 7 / 2 reveals', size: 13, dealt: 7, reveals: 2 },
  { label: 'size 30 / dealt 5', size: 30, dealt: 5 },
  // A real 52-card deck with a three-card hand, as the anchor for what the
  // ceilings actually cost a game author.
  { label: 'size 52 / dealt 3 / split', size: 52, dealt: 3, actions: ['switch', 'split', 'cash'] },
  // The largest shape both ceilings admit on the wide-deck axis, where the
  // estimate is tightest and therefore where the ceiling costs the most wall
  // time. This row is the one the published worst case is derived from.
  { label: 'size 70 / dealt 3 / split', size: 70, dealt: 3, actions: ['switch', 'split', 'cash'] },
  { label: 'size 90 / dealt 3 / split', size: 90, dealt: 3, actions: ['switch', 'split', 'cash'] },
  { label: 'size 100 / dealt 3', size: 100, dealt: 3 },
]);

function draft(probe: Probe): SequentialCardsDefinition {
  return {
    apiVersion: ENGINE_API_VERSION,
    moduleId: SEQUENTIAL_CARDS_MODULE_ID,
    id: `calibration-${probe.size}-${probe.dealt}`,
    version: '1.0.0',
    ladder: { size: probe.size, dealt: probe.dealt, objective: 'middle' },
    reveal: {
      modelVersion: 'calibration/v1',
      count: probe.reveals ?? 1,
      eligibility: 'unbacked',
      sortRemaining: true,
    },
    backing: { maxOpenBeforeReveal: probe.width ?? 1, rebackMode: 'move' },
    sideMarkets: [],
    ticket: { requiresBackedMarket: true, stakeScope: 'per-selection' },
    pricing: {
      entryRtp: rational(24n, 25n),
      liquidationSpread: rational(0n),
      rounding: 'floor',
      minStakeCredits: 500_000n,
      stakeStepCredits: 500_000n,
      actions: probe.actions ?? ['switch', 'cash'],
      splitMode: 'even',
    },
    risk: { maxWinMultiple: 10_000_000n, capMustNotBind: false },
    seed: { operatorSeedScope: 'per-round', clientEntropy: 'required', clientSeedBytes: 16 },
  } as unknown as SequentialCardsDefinition;
}

interface Row {
  readonly label: string;
  readonly ops: bigint;
  readonly estimatedCells: bigint;
  readonly realisedCells: number | undefined;
  readonly ms: number;
  readonly outcome: string;
}

function measure(label: string, definition: SequentialCardsDefinition): Row {
  const ops = estimateAnalysisWork(definition);
  const estimatedCells = estimateAnalysisCells(definition);
  const started = performance.now();
  let realisedCells: number | undefined;
  let outcome = 'walked';
  try {
    realisedCells = analyseDefinition(definition).cells;
  } catch (error) {
    const reason = (error as { details?: { reason?: string } }).details?.reason;
    outcome = reason ?? (error as Error).message.slice(0, 32);
  }
  return { label, ops, estimatedCells, realisedCells, ms: performance.now() - started, outcome };
}

const cell = (value: string, width: number): string => value.padStart(width);

// The references were analysed at import, and `analyseDefinition` memoises on
// definition identity, so timing them here would report the cache and not the
// walk. Their headroom against the two ceilings is the claim worth printing;
// the probe table below re-measures the same shapes from a fresh draft.
console.log(
  `${'shipped reference'.padEnd(34)} ${cell('est ops', 12)} ${cell('ops head', 9)} ${cell('est cells', 11)} ${cell('cell head', 10)} ${cell('cells', 9)}`,
);
for (const reference of SEQUENTIAL_CARDS_REFERENCES) {
  const ops = estimateAnalysisWork(reference);
  const cells = estimateAnalysisCells(reference);
  const realised = analyseDefinition(reference).cells;
  console.log(
    `${reference.id.padEnd(34)} ${cell(ops.toString(), 12)} ${cell(`${(Number(CARDS_MAX_ANALYSIS_OPS) / Number(ops)).toFixed(1)}x`, 9)} ${cell(cells.toString(), 11)} ${cell(`${(CARDS_MAX_ANALYSIS_CELLS / Number(cells)).toFixed(1)}x`, 10)} ${cell(String(realised), 9)}`,
  );
}

const rows: Row[] = [];
for (const probe of PROBES) {
  // `defineCardsGame` would refuse most of these on economics it never gets to
  // prove, so the calibration drives the walk directly on a drafted definition.
  rows.push(measure(probe.label, draft(probe)));
}

console.log(
  `\n${'probe shape'.padEnd(34)} ${cell('est ops', 12)} ${cell('est cells', 11)} ${cell('cells', 9)} ${cell('ms', 8)} ${cell('ns/op', 7)} ${cell('loose', 7)}  outcome`,
);
let worstRate = 0;
let worstLabel = '';
for (const row of rows) {
  const rate = row.outcome === 'walked' ? (row.ms * 1e6) / Number(row.ops) : Number.NaN;
  const loose =
    row.realisedCells !== undefined && row.realisedCells > 0
      ? Number(row.estimatedCells) / row.realisedCells
      : Number.NaN;
  if (Number.isFinite(rate) && rate > worstRate) {
    worstRate = rate;
    worstLabel = row.label;
  }
  console.log(
    `${row.label.padEnd(34)} ${cell(row.ops.toString(), 12)} ${cell(row.estimatedCells.toString(), 11)} ${cell(String(row.realisedCells ?? '-'), 9)} ${cell(row.ms.toFixed(0), 8)} ${cell(Number.isFinite(rate) ? rate.toFixed(0) : '-', 7)} ${cell(Number.isFinite(loose) ? `${loose.toFixed(1)}x` : '-', 7)}  ${row.outcome}`,
  );
}

const walked = rows.filter((row) => row.outcome === 'walked');
const slowest = walked.reduce((worst, row) => (row.ms > worst.ms ? row : worst), walked[0] as Row);
const refused = rows.filter((row) => row.outcome !== 'walked');
const slowestRefusal = refused.reduce((worst, row) => Math.max(worst, row.ms), 0);
const perCell = walked.reduce(
  (worst, row) => Math.max(worst, (row.ms * 1e6) / (row.realisedCells ?? 1)),
  0,
);

// The two ceilings bind on different axes and the nominal product of the
// operations ceiling with the worst rate is not reachable: a shape tight enough
// to run at that rate is a wide deck with a narrow hand, and the cell ceiling
// refuses it first. The honest worst case is the slowest shape both admit.
console.log(
  `\nworst rate      ${worstRate.toFixed(0)} ns per estimated operation, on "${worstLabel}".` +
    `\nworst per cell  ${perCell.toFixed(0)} ns.` +
    `\nslowest walk    ${(slowest.ms / 1000).toFixed(1)} s, on "${slowest.label}" (${slowest.realisedCells} cells) — the` +
    `\n                slowest shape both ceilings admit, and therefore the wall-time bound.` +
    `\nslowest refusal ${slowestRefusal.toFixed(0)} ms across ${refused.length} refused shapes: every ceiling is checked` +
    `\n                before the walk, so no refusal walks anything.` +
    `\nCARDS_MAX_ANALYSIS_OPS   = ${CARDS_MAX_ANALYSIS_OPS} (nominally ${((Number(CARDS_MAX_ANALYSIS_OPS) * worstRate) / 1e9).toFixed(0)} s at the worst rate, not` +
    `\n                           reachable: the cell ceiling binds first on that axis).` +
    `\nCARDS_MAX_ANALYSIS_CELLS = ${CARDS_MAX_ANALYSIS_CELLS} (${((CARDS_MAX_ANALYSIS_CELLS * perCell) / 1e9).toFixed(0)} s at the worst per-cell rate).`,
);

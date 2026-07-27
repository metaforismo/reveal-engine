import { uniform } from '../core/fairness.js';
import { rational } from '../core/rational.js';
import type { EvidenceSchedule, GameDefinition } from '../core/contracts.js';
const schedule: EvidenceSchedule = {
  eventCount: 7,
  derive(seed, context, truth) {
    return Object.freeze(
      Array.from({ length: 7 }, (_, index) => {
        const favour = index % 2 === 0 ? 5n : 2n;
        const other = 1n;
        const total = Number(favour + 2n * other);
        const roll = uniform(seed, context, 'constellation-clue', index, total);
        const target = roll < Number(favour) ? truth : (truth + 1 + (roll % 2)) % 3;
        return Object.freeze({
          index,
          target,
          favour,
          other,
          label: index % 2 === 0 ? 'spectrum' : 'orbit',
        });
      }),
    );
  },
};
/** Materially different: three outcomes, non-uniform priors, seven alternating clues, no continuation. */
export const constellationReference: GameDefinition = Object.freeze({
  id: 'constellation-synthetic-v1',
  outcomes: ['nova', 'quasar', 'pulsar'],
  priorWeights: [5n, 3n, 2n],
  evidence: schedule,
  pricing: {
    firstEntryRtp: rational(9700n, 10000n),
    liquidationSpread: rational(25n, 10000n),
    rounding: 'floor' as const,
  },
  risk: { maxWinMultiple: 250n },
});

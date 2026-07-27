import { uniform } from '../core/fairness.js';
import { rational } from '../core/rational.js';
import type { EvidenceSchedule, GameDefinition } from '../core/contracts.js';
const schedule: EvidenceSchedule = {
  eventCount: 120,
  derive(seed, context, truth) {
    return Object.freeze(
      Array.from({ length: 120 }, (_, index) => {
        const spike = [30, 70, 100].includes(index);
        const favour = spike ? (index === 100 ? 42n : 3n) : 9n;
        const other = spike ? (index === 100 ? 11n : 1n) : 8n;
        const total = Number(favour + 3n * other);
        const roll = uniform(seed, context, 'evidence', index, total);
        const target = roll < Number(favour) ? truth : (truth + 1 + (roll % 3)) % 4;
        return Object.freeze({ index, target, favour, other, label: spike ? 'spike' : 'weak' });
      }),
    );
  },
};
/** Compatibility adapter only; it contains no BLACK SIGNAL UI, art, story, or copy. */
export const blackSignalReference: GameDefinition = Object.freeze({
  id: 'black-signal-reference-v1',
  outcomes: ['A', 'B', 'C', 'D'],
  priorWeights: [1n, 1n, 1n, 1n],
  evidence: schedule,
  pricing: {
    firstEntryRtp: rational(9550n, 10000n),
    liquidationSpread: rational(0n),
    rounding: 'floor' as const,
  },
  risk: { maxWinMultiple: 5000n, continuation: { maxRides: 1, rtpFloor: rational(8500n, 10000n) } },
});

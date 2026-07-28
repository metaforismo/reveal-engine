import { uniform } from '../core/fairness.js';
import { rational } from '../core/rational.js';
import type { EvidenceSchedule, GameDefinition } from '../core/contracts.js';
import { ENGINE_API_VERSION } from '../core/contracts.js';
import { defineGame } from '../core/adapter.js';
import { deriveMaxContinuations } from '../core/continuation.js';
const firstEntryRtp = rational(9550n, 10000n);
const rtpFloor = rational(8500n, 10000n);
const maxRides = deriveMaxContinuations(firstEntryRtp, rtpFloor);
if (maxRides !== 2) throw new Error('BLACK SIGNAL reference continuation policy drifted');
const schedule: EvidenceSchedule = {
  modelVersion: 'black-signal-evidence/v1',
  eventCount: 120,
  derive(seed, context, truth) {
    const spikeStrengths = [
      { favour: 3n, other: 1n },
      { favour: 3n, other: 1n },
      { favour: 42n, other: 11n },
    ] as const;
    const spikeAt = new Map<number, (typeof spikeStrengths)[number]>();
    const span = 40;
    spikeStrengths.forEach((strength, spikeIndex) => {
      const low = spikeIndex === 0 ? 5 : spikeIndex * span;
      const high = spikeIndex === spikeStrengths.length - 1 ? 115 : (spikeIndex + 1) * span;
      let index = low + uniform(seed, context, 'spike', spikeIndex, high - low);
      while (spikeAt.has(index)) index = low + ((index + 1 - low) % (high - low));
      spikeAt.set(index, strength);
    });
    return Object.freeze(
      Array.from({ length: 120 }, (_, index) => {
        const spike = spikeAt.get(index);
        const favour = spike?.favour ?? 9n;
        const other = spike?.other ?? 8n;
        const total = Number(favour + 3n * other);
        const roll = uniform(seed, context, 'evidence', index, total);
        const target = roll < Number(favour) ? truth : (truth + 1 + (roll % 3)) % 4;
        return Object.freeze({ index, target, favour, other, label: spike ? 'spike' : 'weak' });
      }),
    );
  },
};
/** Compatibility adapter only; it contains no BLACK SIGNAL UI, art, story, or copy. */
export const blackSignalReference: GameDefinition = defineGame({
  apiVersion: ENGINE_API_VERSION,
  adapterVersion: '1.1.0',
  id: 'black-signal-reference-v1',
  outcomes: ['A', 'B', 'C', 'D'],
  priorWeights: [1n, 1n, 1n, 1n],
  evidence: schedule,
  pricing: {
    firstEntryRtp,
    liquidationSpread: rational(0n),
    rounding: 'floor' as const,
  },
  risk: { maxWinMultiple: 5000n, continuation: { maxRides, rtpFloor } },
});

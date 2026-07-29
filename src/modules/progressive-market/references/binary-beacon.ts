import { defineGame } from '../adapter.js';
import { ENGINE_API_VERSION, type EvidenceSchedule, type GameDefinition } from '../contracts.js';
import { uniform } from '../fairness.js';
import { rational } from '../../../core/rational.js';

const evidence: EvidenceSchedule = {
  modelVersion: 'binary-beacon-evidence/v1',
  eventCount: 3,
  derive(seed, context, truth) {
    return Object.freeze(
      Array.from({ length: 3 }, (_, index) => {
        const favour = 7n;
        const other = 3n;
        const target = uniform(seed, context, 'binary-beacon', index, 10) < 7 ? truth : 1 - truth;
        return Object.freeze({ index, target, favour, other, label: `beacon-${index}` });
      }),
    );
  },
};

/** Minimal two-outcome conformance fixture with unequal priors and a tiny schedule. */
export const binaryBeaconReference: GameDefinition = defineGame({
  apiVersion: ENGINE_API_VERSION,
  adapterVersion: '1.0.0',
  id: 'binary-beacon-conformance-v1',
  outcomes: ['near', 'far'],
  priorWeights: [3n, 1n],
  evidence,
  pricing: {
    firstEntryRtp: rational(99n, 100n),
    liquidationSpread: rational(0n),
    rounding: 'floor',
  },
  risk: { maxWinMultiple: 100n },
});

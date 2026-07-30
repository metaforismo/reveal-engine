import type { SurvivalDefinition } from '../../src/modules/staged-survival/contracts.js';
import { parseRoundRefId } from '../../src/modules/staged-survival/validation.js';
import { roundIdentityOf, seedCommitment } from '../../src/modules/staged-survival/fairness.js';

export function survivalAdmission(
  definition: SurvivalDefinition,
  seedHex: string,
  roundId: string,
): { readonly roundId: string; readonly seedCommitment: string } {
  return Object.freeze({
    roundId: parseRoundRefId(roundId).roundId,
    seedCommitment: seedCommitment(seedHex, definition, roundIdentityOf(definition, roundId)),
  });
}

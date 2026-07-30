import { cardsRoundOf } from '../../src/modules/sequential-cards/adapter.js';
import type { SequentialCardsDefinition } from '../../src/modules/sequential-cards/contracts.js';
import { cardsSeedCommitment } from '../../src/modules/sequential-cards/transcript.js';

export const TEST_CLIENT_SEED = '11'.repeat(32);

export function cardsAdmission(
  definition: SequentialCardsDefinition,
  seedHex: string,
  roundId: string,
): { readonly seedCommitment: string; readonly clientSeed: string } {
  return Object.freeze({
    seedCommitment: cardsSeedCommitment(seedHex, definition, cardsRoundOf(definition, roundId)),
    clientSeed: TEST_CLIENT_SEED,
  });
}

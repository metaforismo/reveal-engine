import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/aether-order-transcripts.json' with { type: 'json' };
import {
  allDrawVectors,
  aetherOrderClassic,
  aetherOrderSeven,
  derivePermutation,
  factorial,
  fisherYates,
  permutationAdapterFingerprint,
  uniformBelow,
} from '../src/modules/permutation/aether/index.js';
import { encodeFields } from '../src/internal/canonical.js';

const referenceDraws = Object.freeze([
  ['4', '3', '1', '0'],
  ['3', '2', '0', '1'],
  ['1', '2', '2', '1'],
  ['4', '2', '0', '0'],
  ['4', '5', '4', '3', '1', '0'],
  ['6', '1', '3', '3', '1', '1'],
  ['6', '2', '1', '0', '0', '1'],
  ['1', '3', '2', '3', '1', '1'],
]);

function independentlyDerive(
  seedHex: string,
  context: {
    gameId: string;
    variantId: string;
    roundId: string;
    clientSeed: string;
    nonce: number;
  },
  game: typeof aetherOrderClassic,
  n: number,
): readonly number[] {
  const order = Array.from({ length: n }, (_, index) => index);
  const range = 1n << 256n;
  for (let counter = 0; counter < n - 1; counter += 1) {
    const modulus = BigInt(n - counter);
    const limit = range - (range % modulus);
    let pick = 0n;
    for (let rejection = 0n; ; rejection += 1n) {
      const payload = encodeFields([
        'sampler',
        'reveal-engine/permutation-v1',
        game.adapterVersion,
        permutationAdapterFingerprint(game),
        context.gameId,
        context.variantId,
        context.roundId,
        context.clientSeed,
        context.nonce,
        'aether-order/shuffle-v2',
        counter,
        rejection,
        modulus,
      ]);
      const value = BigInt(
        `0x${createHmac('sha256', Buffer.from(seedHex, 'hex')).update(payload).digest('hex')}`,
      );
      if (value < limit) {
        pick = value % modulus;
        break;
      }
    }
    const index = n - 1 - counter;
    const selected = Number(pick);
    const saved = order[index] as number;
    order[index] = order[selected] as number;
    order[selected] = saved;
  }
  return order;
}

describe('AETHER ORDER rejection sampler and shuffle', () => {
  it('matches the committed oracle draws for every fixture context', () => {
    fixtures.vectors.forEach((vector, vectorIndex) => {
      const n = vector.context.variantId === 'classic' ? 5 : 7;
      const context = { gameId: 'aether-order', ...vector.context };
      const actual = Array.from({ length: n - 1 }, (_, counter) =>
        uniformBelow(
          vector.serverSeed,
          n === 5 ? aetherOrderClassic : aetherOrderSeven,
          context,
          'shuffle-v2',
          counter,
          BigInt(n - counter),
        ).toString(),
      );
      expect(actual, vector.context.roundId).toEqual(referenceDraws[vectorIndex]);
    });
  });

  it('uses an accept boundary exactly divisible by every legal modulus', () => {
    const range = 1n << 256n;
    for (let modulus = 1n; modulus <= 12n; modulus += 1n) {
      const limit = range - (range % modulus);
      expect(limit % modulus).toBe(0n);
      expect(limit).toBeLessThanOrEqual(range);
    }
  });

  it('maps the complete draw-vector space bijectively onto S_n for n=3..7', () => {
    for (let n = 3; n <= 7; n += 1) {
      const images = new Set(allDrawVectors(n).map((draws) => fisherYates(n, draws).join(',')));
      expect(images.size, `n=${n}`).toBe(factorial(n));
    }
  });

  it('agrees with an independent implementation of the normative schedule', () => {
    for (const vector of fixtures.vectors) {
      const game = vector.context.variantId === 'classic' ? aetherOrderClassic : aetherOrderSeven;
      const context = { gameId: 'aether-order', ...vector.context };
      expect(derivePermutation(vector.serverSeed, game, context)).toEqual(
        independentlyDerive(vector.serverSeed, context, game, game.n),
      );
    }
  });
});

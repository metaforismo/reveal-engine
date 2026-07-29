import { describe, expect, it } from 'vitest';
import { ENGINE_LIMITS } from '../src/api/limits.js';
import {
  sealCommitment,
  sealLegacyCommitment,
  sealSeedCommitment,
} from '../src/core/commitment.js';
import { countingProbability, factorial, fallingFactorial } from '../src/core/combinatorics.js';
import { assertClaimBudget, assertLoggedChoices } from '../src/core/module.js';
import { CommandLedger, commandFingerprint } from '../src/core/ledger.js';
import { rational } from '../src/core/rational.js';
import {
  RandomTape,
  uniformBigInt,
  uniformPermutation,
  type SamplerScope,
} from '../src/core/random.js';
import {
  reduceWeights,
  scaleWeights,
  weightGcd,
  weightProbability,
  weightVector,
} from '../src/core/weights.js';
import { COMMITMENT_VERSION } from '../src/core/versions.js';
import { seed } from './helpers.js';

const scope: SamplerScope = {
  domain: 'core-primitives',
  roundId: 'round-1',
  proofVersion: COMMITMENT_VERSION,
};

describe('exact weight vectors', () => {
  it('reduces by the common factor and preserves ratios exactly', () => {
    expect(weightGcd([12n, 18n, 30n])).toBe(6n);
    expect(reduceWeights([12n, 18n, 30n])).toEqual([2n, 3n, 5n]);
    expect(reduceWeights([7n, 11n])).toEqual([7n, 11n]);
  });

  it('admits an outcome eliminated to exactly zero', () => {
    const vector = weightVector([0n, 3n, 1n]);
    expect(vector.total).toBe(4n);
    expect(weightProbability(vector, 0)).toEqual(rational(0n));
    expect(weightProbability(vector, 1)).toEqual(rational(3n, 4n));
    expect(weightGcd([0n, 4n, 6n])).toBe(2n);
    expect(reduceWeights([0n, 4n, 6n])).toEqual([0n, 2n, 3n]);
  });

  it('rejects an impossible round, a negative weight, and an unknown index', () => {
    expect(() => weightVector([0n, 0n])).toThrowError(
      expect.objectContaining({ code: 'INVALID_WEIGHTS' }),
    );
    expect(() => weightVector([-1n, 2n])).toThrowError(
      expect.objectContaining({ code: 'INVALID_RATIONAL' }),
    );
    expect(() => weightVector([1n])).toThrowError(
      expect.objectContaining({ code: 'INVALID_WEIGHTS' }),
    );
    expect(() => weightProbability(weightVector([1n, 1n]), 2)).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_OUTCOME' }),
    );
  });

  it('scales like a Bayesian update and stays reduced', () => {
    const posterior = scaleWeights(weightVector([1n, 1n, 1n]), (index) => (index === 1 ? 4n : 2n));
    expect(posterior.weights).toEqual([1n, 2n, 1n]);
    expect(posterior.total).toBe(4n);
  });
});

describe('seeded permutations and recorded tapes', () => {
  it('produces a genuine permutation, deterministically', () => {
    for (const size of [0, 1, 2, 13, 52]) {
      const order = uniformPermutation(seed(3), scope, 'deck', size);
      expect(order).toHaveLength(size);
      expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: size }, (_, i) => i));
      expect(uniformPermutation(seed(3), scope, 'deck', size)).toEqual(order);
    }
  });

  it('separates permutations by label, round, and seed', () => {
    const base = uniformPermutation(seed(4), scope, 'deck', 52).join(',');
    const otherLabel = uniformPermutation(seed(4), scope, 'burn', 52).join(',');
    const otherRound = uniformPermutation(
      seed(4),
      { ...scope, roundId: 'round-2' },
      'deck',
      52,
    ).join(',');
    const otherSeed = uniformPermutation(seed(5), scope, 'deck', 52).join(',');
    expect(new Set([base, otherLabel, otherRound, otherSeed]).size).toBe(4);
  });

  it('rejects a permutation beyond the public size limit', () => {
    expect(() =>
      uniformPermutation(seed(1), scope, 'deck', ENGINE_LIMITS.maxPermutationSize + 1),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONTEXT' }));
  });

  it('replays a tape draw-for-draw and digests it canonically', () => {
    const run = (): RandomTape => {
      const tape = new RandomTape(seed(6), scope);
      tape.draw('stage', 0, 6n);
      tape.index('stage', 1, 4);
      tape.draw('stage', 2, 1n << 200n);
      return tape;
    };
    const first = run();
    const second = run();
    expect(second.draws).toEqual(first.draws);
    expect(second.digest()).toBe(first.digest());
    expect(first.draws).toHaveLength(3);
    expect(first.draws[0]?.value).toBe(uniformBigInt(seed(6), scope, 'stage', 0, 6n));

    const diverged = new RandomTape(seed(6), scope);
    diverged.draw('stage', 0, 6n);
    expect(diverged.digest()).not.toBe(first.digest());
  });

  it('bounds tape length and rejects an oversized budget', () => {
    const tape = new RandomTape(seed(7), scope, 2);
    tape.draw('x', 0, 5n);
    tape.draw('x', 1, 5n);
    expect(() => tape.draw('x', 2, 5n)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONTEXT' }),
    );
    expect(() => new RandomTape(seed(7), scope, ENGINE_LIMITS.maxTapeDraws + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONTEXT' }),
    );
  });
});

describe('commitment sealing', () => {
  it('binds the seed and the body separately', () => {
    const body = Buffer.from('body');
    const sealed = sealCommitment(seed(8), body);
    expect(sealed).toMatch(/^[0-9a-f]{64}$/u);
    expect(sealCommitment(seed(9), body)).not.toBe(sealed);
    expect(sealCommitment(seed(8), Buffer.from('bodz'))).not.toBe(sealed);
    expect(sealCommitment(seed(8).toUpperCase(), body)).toBe(sealed);
  });

  it('rejects a malformed seed before hashing anything', () => {
    for (const bad of ['', 'zz', '00'.repeat(33)]) {
      expect(() => sealCommitment(bad, Buffer.alloc(0))).toThrowError(
        expect.objectContaining({ code: 'INVALID_SEED' }),
      );
      expect(() => sealLegacyCommitment(bad, 'payload')).toThrowError(
        expect.objectContaining({ code: 'INVALID_SEED' }),
      );
    }
  });
});

describe('shared command ledger', () => {
  const ledger = (): CommandLedger => new CommandLedger({ maxWinMultiple: 10n });

  it('replays an exact retry and rejects a reused key with a different payload', async () => {
    const book = ledger();
    const fingerprint = commandFingerprint('open', [0, 1, 100n]);
    const first = await book.execute('k', fingerprint, () =>
      book.mint('k', fingerprint, 'open', 0, 100n, 0n, false),
    );
    const replay = await book.execute('k', fingerprint, () => {
      throw new Error('must not re-run');
    });
    expect(replay).toBe(first);
    await expect(
      book.execute('k', commandFingerprint('open', [0, 2, 100n]), () =>
        book.mint('k', 'x', 'open', 0, 100n, 0n, false),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(book.ledgerRevision).toBe(1);
  });

  it('accumulates the cap basis across independently funded simultaneous claims', async () => {
    const book = ledger();
    for (const [index, stake] of [50n, 30n, 20n].entries()) {
      const key = `open-${index}`;
      const fingerprint = commandFingerprint('open', [0, index, stake]);
      await book.execute(key, fingerprint, () => {
        const receipt = book.mint(key, fingerprint, 'open', 0, stake, 0n, false);
        book.fundStake(stake, 'external');
        return receipt;
      });
    }
    // Three positions the player actually paid for, so the ceiling is 100 x 10.
    expect(book.capBasisStake).toBe(100n);
    expect(book.creditWithinCap(rational(5000n))).toMatchObject({ credited: 1000n, capped: true });
    expect(book.ledgerRevision).toBe(3);
    expect(book.receiptCount).toBe(3);
  });

  it('never lets recycled winnings grow the ceiling they came from', () => {
    const book = ledger();
    book.fundStake(10n, 'external');
    const won = book.creditWithinCap(rational(60n));
    book.applyCredit(won.credited);
    expect(book.liquidBalance).toBe(60n);

    // Re-staking a win moves value inside the round; the basis must not move.
    expect(book.fundStake(40n, 'recycled')).toBe(10n);
    expect(book.capBasisStake).toBe(10n);
    expect(book.liquidBalance).toBe(20n);
    expect(book.creditWithinCap(rational(1000n))).toMatchObject({ credited: 80n, capped: true });

    expect(() => book.fundStake(999n, 'recycled')).toThrowError(
      expect.objectContaining({ code: 'CLAIM_REJECTED' }),
    );
    expect(() => book.fundStake(0n, 'external')).toThrowError(
      expect.objectContaining({ code: 'INVALID_RATIONAL' }),
    );
    expect(() => book.fundStake(1n, 'wallet' as never)).toThrowError(
      expect.objectContaining({ code: 'CLAIM_REJECTED' }),
    );
  });

  it('never credits beyond the remaining chain cap', async () => {
    const book = ledger();
    const fingerprint = commandFingerprint('open', [0, 0, 10n]);
    await book.execute('open', fingerprint, () => {
      const receipt = book.mint('open', fingerprint, 'open', 0, 10n, 0n, false);
      book.fundStake(10n, 'external');
      return receipt;
    });
    const partial = book.creditWithinCap(rational(60n));
    expect(partial).toMatchObject({ credited: 60n, capped: false });
    book.applyCredit(partial.credited);
    const rest = book.creditWithinCap(rational(1000n));
    expect(rest).toMatchObject({ credited: 40n, capped: true });
    book.applyCredit(rest.credited);
    expect(book.creditWithinCap(rational(1n)).credited).toBe(0n);
    expect(book.liquidBalance).toBe(100n);
  });

  it('refuses to credit a round that has taken no stake, instead of paying zero', () => {
    const book = ledger();
    // Silently paying 0 against a positive theoretical claim would hide a module
    // state-machine bug behind a receipt that says it was not capped.
    expect(() => book.creditWithinCap(rational(500n))).toThrowError(
      expect.objectContaining({ code: 'CLAIM_REJECTED' }),
    );
    expect(() => book.fundStake(1n, 'recycled')).toThrowError(
      expect.objectContaining({ code: 'CLAIM_REJECTED' }),
    );
    expect(() => book.applyCredit(-1n)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RATIONAL' }),
    );
  });

  it('serializes concurrent commands so the ledger revision never forks', async () => {
    const book = ledger();
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, index) => {
        const key = `k-${index}`;
        const fingerprint = commandFingerprint('open', [0, index, 1n]);
        return book.execute(key, fingerprint, () =>
          book.mint(key, fingerprint, 'open', 0, 1n, 0n, false),
        );
      }),
    );
    const revisions = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value.ledgerRevision] : [],
    );
    expect(new Set(revisions).size).toBe(16);
    expect(book.ledgerRevision).toBe(16);
  });

  it('rejects a snapshot whose ledger revision does not match its receipt log', () => {
    const book = ledger();
    expect(() =>
      book.restoreBalances({ ledgerRevision: 3, liquidBalance: 0n, capBasisStake: undefined }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
    expect(() =>
      book.restoreBalances({ ledgerRevision: 0, liquidBalance: -1n, capBasisStake: undefined }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
    expect(() =>
      book.restoreBalances({ ledgerRevision: 0, liquidBalance: 101n, capBasisStake: 10n }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  it('rejects a malformed idempotency key and an invalid cap configuration', async () => {
    const book = ledger();
    await expect(
      book.execute('', 'f', () => book.mint('', 'f', 'open', 0, 1n, 0n, false)),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(() => new CommandLedger({ maxWinMultiple: 0n })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ADAPTER' }),
    );
    expect(() => new CommandLedger({ maxWinMultiple: 1n, maxReceipts: 0 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ADAPTER' }),
    );
  });

  it('stops accepting new commands once the receipt budget is exhausted', async () => {
    const book = new CommandLedger({ maxWinMultiple: 1n, maxReceipts: 1 });
    const fingerprint = commandFingerprint('open', [0]);
    await book.execute('a', fingerprint, () =>
      book.mint('a', fingerprint, 'open', 0, 1n, 0n, false),
    );
    await expect(
      book.execute('b', fingerprint, () => book.mint('b', fingerprint, 'open', 0, 1n, 0n, false)),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('exact counting over structured truth spaces', () => {
  it('counts factorials and falling factorials exactly', () => {
    expect(factorial(0)).toBe(1n);
    expect(factorial(8)).toBe(40_320n);
    expect(factorial(30)).toBe(265252859812191058636308480000000n);
    expect(fallingFactorial(8, 3)).toBe(336n);
    expect(fallingFactorial(8, 8)).toBe(factorial(8));
    expect(fallingFactorial(3, 8)).toBe(0n);
  });

  it('prices a combinatorial event the flat weight vector cannot hold', () => {
    // A trifecta over eight runners is one of 336 events; ENGINE_LIMITS.maxOutcomes is 64.
    expect(336n).toBeGreaterThan(BigInt(ENGINE_LIMITS.maxOutcomes));
    expect(countingProbability(factorial(5), factorial(8))).toEqual(rational(1n, 336n));
    expect(countingProbability(0n, factorial(8))).toEqual(rational(0n));
  });

  it('rejects a contradictory or unbounded counting measure', () => {
    expect(() => countingProbability(2n, 1n)).toThrowError(
      expect.objectContaining({ code: 'INVALID_WEIGHTS' }),
    );
    expect(() => countingProbability(1n, 0n)).toThrowError(
      expect.objectContaining({ code: 'INVALID_WEIGHTS' }),
    );
    expect(() => factorial(ENGINE_LIMITS.maxPermutationSize + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONTEXT' }),
    );
  });
});

describe('seed pre-commitment for choice-timed rounds', () => {
  const binding = {
    moduleId: 'fixture',
    definitionId: 'definition-v1',
    definitionFingerprint: 'ab'.repeat(32),
    roundId: 'round-1',
    proofVersion: COMMITMENT_VERSION,
  } as const;

  it('binds the seed, the module, the frozen economics, and the round', () => {
    const sealed = sealSeedCommitment(seed(31), binding);
    expect(sealed).toMatch(/^[0-9a-f]{64}$/u);
    expect(sealSeedCommitment(seed(32), binding)).not.toBe(sealed);
    for (const changed of [
      { ...binding, moduleId: 'other' },
      { ...binding, definitionId: 'other' },
      { ...binding, definitionFingerprint: 'cd'.repeat(32) },
      { ...binding, roundId: 'round-2' },
    ])
      expect(sealSeedCommitment(seed(31), changed)).not.toBe(sealed);
  });

  it('is domain-separated from a body commitment and fails closed on bad input', () => {
    expect(sealSeedCommitment(seed(31), binding)).not.toBe(
      sealCommitment(seed(31), Buffer.alloc(0)),
    );
    expect(() => sealSeedCommitment(seed(31), null as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONTEXT' }),
    );
    expect(() =>
      sealSeedCommitment(seed(31), { ...binding, definitionFingerprint: 'zz' } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONTEXT' }));
    expect(() => sealSeedCommitment('nope', binding)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SEED' }),
    );
  });
});

describe('contract guards core actually enforces', () => {
  it('bounds a logged choice list and refuses choices a module does not model', () => {
    expect(assertLoggedChoices(undefined, 'before-step')).toEqual([]);
    expect(assertLoggedChoices(['a', 'b'], 'before-step')).toEqual(['a', 'b']);
    expect(() => assertLoggedChoices(['a'], 'none')).toThrowError(
      expect.objectContaining({ code: 'INVALID_CHOICE' }),
    );
    expect(() =>
      assertLoggedChoices(
        Array.from({ length: ENGINE_LIMITS.maxLoggedChoices + 1 }, () => 'a'),
        'before-step',
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CHOICE' }));
    expect(() => assertLoggedChoices('a' as never, 'before-step')).toThrowError(
      expect.objectContaining({ code: 'INVALID_CHOICE' }),
    );
  });

  it('bounds simultaneous claims against the declared budget', () => {
    expect(() => assertClaimBudget(0, 1)).not.toThrow();
    expect(() => assertClaimBudget(1, 1)).toThrowError(
      expect.objectContaining({ code: 'CLAIM_REJECTED' }),
    );
    expect(() => assertClaimBudget(-1, 4)).toThrowError(
      expect.objectContaining({ code: 'CLAIM_REJECTED' }),
    );
  });
});

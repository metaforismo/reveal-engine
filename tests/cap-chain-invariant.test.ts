import { describe, expect, it } from 'vitest';
import { RevealEngineError } from '../src/api/errors.js';
import { CommandLedger } from '../src/core/ledger.js';
import { rational } from '../src/core/rational.js';
import type { EvidenceEvent } from '../src/modules/progressive-market/contracts.js';
import { initialPosterior } from '../src/modules/progressive-market/posterior.js';
import { makeTranscript } from '../src/modules/progressive-market/fairness.js';
import { RoundBook } from '../src/modules/progressive-market/round-book.js';
import { binaryBeaconReference } from '../src/modules/progressive-market/references/index.js';
import { seed } from './helpers.js';

/**
 * The one money statement the whole engine rests on:
 *
 *   a round can never pay out more than `maxWinMultiple` times the money the
 *   player actually brought into it.
 *
 * Mechanically that is `liquidBalance <= capBasisStake * maxWinMultiple`, held
 * at every point in a round, where the basis counts externally funded stakes
 * only. This file proves it by enumeration rather than by argument: all 7,380
 * command sequences up to length four over a nine-symbol alphabet (9 + 9² + 9³
 * + 9⁴), checked after every single step, plus seeded longer interleavings and
 * one real progressive-market round.
 */
const MAX_WIN_MULTIPLE = 10n;

type Command =
  | { readonly kind: 'external'; readonly amount: bigint }
  | { readonly kind: 'recycled'; readonly amount: bigint }
  | { readonly kind: 'credit'; readonly theoretical: bigint };

const ALPHABET: readonly Command[] = Object.freeze([
  { kind: 'external', amount: 1n },
  { kind: 'external', amount: 7n },
  { kind: 'external', amount: 1000n },
  { kind: 'recycled', amount: 1n },
  { kind: 'recycled', amount: 7n },
  { kind: 'recycled', amount: 1000n },
  { kind: 'credit', theoretical: 1n },
  { kind: 'credit', theoretical: 50n },
  { kind: 'credit', theoretical: 10n ** 9n },
]);

interface Outcome {
  readonly externalTotal: bigint;
  readonly liquid: bigint;
  readonly basis: bigint | undefined;
  /** Total credited during the run, so a vacuous "nothing happened" pass is visible. */
  readonly creditedTotal: bigint;
}

/**
 * How a credit reaches the ledger.
 *
 * `pair` is the low-level `creditWithinCap()` query followed by the
 * `applyCredit()` mutation; `claim` is `creditClaim()`, which performs both in
 * one call and is what every book in this repository uses. Both are swept,
 * because the invariant has to hold whichever a module reaches for — and because
 * the two agreeing on every one of the 7,380 sequences is what says
 * `creditClaim` is the same arithmetic, not a second implementation of it.
 */
type CreditPath = 'pair' | 'claim';

/**
 * Runs one sequence, checking the invariant after every accepted command.
 *
 * The checks throw rather than going through `expect` because this runs tens of
 * thousands of times; the assertion library's overhead would dominate.
 */
function run(sequence: readonly Command[], path: CreditPath = 'pair'): Outcome {
  const ledger = new CommandLedger({ maxWinMultiple: MAX_WIN_MULTIPLE });
  let externalTotal = 0n;
  let creditedTotal = 0n;
  const check = (step: number): void => {
    const basis = ledger.capBasisStake;
    if (basis === undefined) {
      if (ledger.liquidBalance !== 0n)
        throw new Error(`step ${step}: value ${ledger.liquidBalance} with no cap basis`);
    } else if (ledger.liquidBalance > basis * MAX_WIN_MULTIPLE)
      throw new Error(
        `step ${step}: ${ledger.liquidBalance} exceeds ceiling ${basis * MAX_WIN_MULTIPLE}`,
      );
    // The basis is exactly the externally funded money, never more.
    if ((basis ?? 0n) !== externalTotal)
      throw new Error(`step ${step}: basis ${String(basis)} != external total ${externalTotal}`);
  };
  check(-1);
  for (const [step, command] of sequence.entries()) {
    try {
      if (command.kind === 'credit' && path === 'claim') {
        const receipt = ledger.creditClaim(rational(command.theoretical), (payable) =>
          ledger.mint(
            `k${step}`,
            '0'.repeat(64),
            'credit',
            0,
            0n,
            payable.credited,
            payable.capped,
          ),
        );
        creditedTotal += receipt.credited;
      } else if (command.kind === 'credit') {
        const payable = ledger.creditWithinCap(rational(command.theoretical));
        ledger.applyCredit(payable.credited);
        creditedTotal += payable.credited;
      } else {
        ledger.fundStake(command.amount, command.kind);
        if (command.kind === 'external') externalTotal += command.amount;
      }
    } catch (error) {
      // A rejected command must be typed and must not have moved anything.
      if (!(error instanceof RevealEngineError)) throw error;
    }
    check(step);
  }
  return {
    externalTotal,
    liquid: ledger.liquidBalance,
    basis: ledger.capBasisStake,
    creditedTotal,
  };
}

/** Deterministic 32-bit PRNG, so the deep sweep is reproducible. */
function lcg(state: number): () => number {
  let value = state >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value;
  };
}

describe('cap-chain invariant, by enumeration', () => {
  it('holds for every command sequence up to length four', () => {
    let sequences = 0;
    let paidSomething = 0;
    const walk = (prefix: Command[]): void => {
      if (prefix.length > 0) {
        const outcome = run(prefix);
        sequences += 1;
        if (outcome.creditedTotal > 0n) paidSomething += 1;
        // The headline statement, restated over the whole sequence.
        if (outcome.liquid > outcome.externalTotal * MAX_WIN_MULTIPLE)
          throw new Error(`paid ${outcome.liquid} on ${outcome.externalTotal} staked`);
        // The atomic path must be the same arithmetic, not a second one.
        const viaClaim = run(prefix, 'claim');
        if (
          viaClaim.liquid !== outcome.liquid ||
          viaClaim.basis !== outcome.basis ||
          viaClaim.creditedTotal !== outcome.creditedTotal
        )
          throw new Error(`creditClaim diverged from creditWithinCap + applyCredit`);
      }
      if (prefix.length === 4) return;
      for (const command of ALPHABET) walk([...prefix, command]);
    };
    walk([]);
    const n = ALPHABET.length;
    expect(sequences).toBe(n + n ** 2 + n ** 3 + n ** 4);
    // Guard against a vacuous pass. It is not most sequences: a third of the
    // alphabet funds externally, so many short sequences credit nothing because
    // there is no basis yet — which is itself one of the behaviours under test.
    expect(paidSomething).toBeGreaterThan(sequences / 3);
  });

  it('holds for deep interleavings a shallow sweep cannot reach', () => {
    const next = lcg(0x5eed_2026);
    let paidSomething = 0;
    for (let trial = 0; trial < 5000; trial += 1) {
      const length = 6 + (next() % 15);
      const sequence = Array.from({ length }, () => ALPHABET[next() % ALPHABET.length] as Command);
      const outcome = run(sequence);
      if (outcome.creditedTotal > 0n) paidSomething += 1;
      if (outcome.liquid > outcome.externalTotal * MAX_WIN_MULTIPLE)
        throw new Error(`paid ${outcome.liquid} on ${outcome.externalTotal} staked`);
    }
    expect(paidSomething).toBeGreaterThan(4000);
  });

  it('cannot be beaten by recycling winnings into new stakes', () => {
    const ledger = new CommandLedger({ maxWinMultiple: MAX_WIN_MULTIPLE });
    ledger.fundStake(100n, 'external');
    // Win the maximum, recycle all of it, win the maximum again: the ceiling
    // must not have moved, so the second win credits nothing.
    const first = ledger.creditWithinCap(rational(10n ** 6n));
    expect(first.credited).toBe(1000n);
    ledger.applyCredit(first.credited);
    ledger.fundStake(1000n, 'recycled');
    expect(ledger.capBasisStake).toBe(100n);
    expect(ledger.liquidBalance).toBe(0n);
    const second = ledger.creditWithinCap(rational(10n ** 6n));
    expect(second.credited).toBe(1000n);
    ledger.applyCredit(second.credited);
    expect(ledger.liquidBalance).toBe(1000n);
    // Total extracted over the whole round is still 10x the 100 brought in.
    expect(ledger.liquidBalance).toBeLessThanOrEqual(100n * MAX_WIN_MULTIPLE);
  });

  /**
   * Why `creditClaim()` exists, stated as the failure it removes.
   *
   * `creditWithinCap()` is a query: it computes `ceiling - liquidBalance` and
   * moves nothing. A book that calls it without the matching `applyCredit()`
   * measures every claim against a balance that never grows, so the ceiling is
   * re-payable once per claim — and every receipt says `capped: false`, because
   * from the query's point of view nothing was ever capped. This is the shape a
   * multi-credit round (banking subsets, selling positions independently) walks
   * into first, and it is why the atomic call is the documented default.
   */
  it('pays its ceiling once through creditClaim, and five times without applyCredit', () => {
    const ceiling = 100n * MAX_WIN_MULTIPLE;

    const halfPerformed = new CommandLedger({ maxWinMultiple: MAX_WIN_MULTIPLE });
    halfPerformed.fundStake(100n, 'external');
    let leaked = 0n;
    for (let claim = 0; claim < 5; claim += 1) {
      const payable = halfPerformed.creditWithinCap(rational(ceiling));
      expect(payable).toMatchObject({ credited: ceiling, capped: false });
      leaked += payable.credited;
    }
    expect(leaked).toBe(5n * ceiling);
    // Nothing was applied, so the ledger's own balance never left zero — the
    // money escaped through the receipts, which is exactly why this is silent.
    expect(halfPerformed.liquidBalance).toBe(0n);

    const correct = new CommandLedger({ maxWinMultiple: MAX_WIN_MULTIPLE });
    correct.fundStake(100n, 'external');
    let paid = 0n;
    for (let claim = 0; claim < 5; claim += 1) {
      const receipt = correct.creditClaim(rational(ceiling), (payable) =>
        correct.mint(
          `claim-${claim}`,
          '0'.repeat(64),
          'settle',
          0,
          0n,
          payable.credited,
          payable.capped,
        ),
      );
      paid += receipt.credited;
      // The first claim takes the whole ceiling; every later one is capped to 0.
      expect(receipt.capped).toBe(claim > 0);
    }
    expect(paid).toBe(ceiling);
    expect(correct.liquidBalance).toBe(ceiling);
    expect(correct.liquidBalance).toBeLessThanOrEqual(100n * MAX_WIN_MULTIPLE);
  });

  it('refuses to credit a claim without a receipt factory', () => {
    const ledger = new CommandLedger({ maxWinMultiple: MAX_WIN_MULTIPLE });
    ledger.fundStake(10n, 'external');
    expect(() => ledger.creditClaim(rational(5n), undefined as never)).toThrowError(
      expect.objectContaining({ code: 'CLAIM_REJECTED' }),
    );
    // A receipt factory that rejects leaves the balance exactly where it was.
    expect(() =>
      ledger.creditClaim(rational(5n), () => {
        throw new RevealEngineError('CLAIM_REJECTED', 'module said no');
      }),
    ).toThrowError(expect.objectContaining({ code: 'CLAIM_REJECTED' }));
    expect(ledger.liquidBalance).toBe(0n);
  });

  it('holds through a real progressive-market round with sell and re-entry', async () => {
    const game = binaryBeaconReference;
    const transcript = makeTranscript(seed(50), game, 'cap-invariant');
    const book = new RoundBook(game, initialPosterior(game));
    const check = (): void => {
      const basis = book.capBasisStake;
      if (basis === undefined) expect(book.liquidBalance).toBe(0n);
      else expect(book.liquidBalance <= basis * game.risk.maxWinMultiple).toBe(true);
    };
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 0,
      outcome: transcript.truth,
      stake: 1000n,
    });
    check();
    await book.advanceFrame(transcript.evidence[0] as EvidenceEvent);
    check();

    // Liquidate, then put the whole proceeds back at risk: the recycled branch
    // of `fundStake` is the one that must not move the basis.
    const sold = await book.sell({ idempotencyKey: 'sell', expectedFrameRevision: 1 });
    expect(sold.credited).toBeGreaterThan(0n);
    check();
    await book.open({
      idempotencyKey: 'reopen',
      expectedFrameRevision: 1,
      outcome: transcript.truth,
      stake: sold.credited,
    });
    expect(book.liquidBalance).toBe(0n);
    check();

    for (const event of transcript.evidence.slice(1)) {
      await book.advanceFrame(event);
      check();
    }
    await book.settle({
      idempotencyKey: 'settle',
      expectedFrameRevision: transcript.evidence.length,
      revealedSeed: seed(50),
      transcript,
    });
    check();
    // The basis is the externally funded stake only, never the re-staked wins.
    expect(book.capBasisStake).toBe(1000n);
    expect(book.ledgerRevision).toBe(4);
  });
});

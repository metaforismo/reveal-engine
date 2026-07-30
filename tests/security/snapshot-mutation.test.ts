import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  commandFingerprint,
  RECEIPT_SCHEMA as PERMUTATION_RECEIPT_SCHEMA,
} from '../../src/core/ledger.js';
import { multiply, rational } from '../../src/core/rational.js';
import { snapshotHash, toWireRational } from '../../src/core/snapshot.js';
import { initialPosterior } from '../../src/modules/progressive-market/posterior.js';
import { quote } from '../../src/modules/progressive-market/posterior.js';
import { makeTranscript } from '../../src/modules/progressive-market/fairness.js';
import {
  RoundBook,
  type RoundBookSnapshot,
} from '../../src/modules/progressive-market/round-book.js';
import { constellationReference } from '../../src/modules/progressive-market/references/index.js';
import { makePermutationTranscript } from '../../src/modules/permutation/derivation.js';
import { PermutationBook } from '../../src/modules/permutation/round-book.js';
import { aetherOrderClassicReference } from '../../src/modules/permutation/references/index.js';
import { seed } from '../helpers.js';

type Json = Record<string, unknown>;

function readAt(root: Json, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>(
    (value, key) => (value as Record<string | number, unknown>)[key],
    root,
  );
}

function writeAt(root: Json, path: readonly (string | number)[], value: unknown): Json {
  const clone = structuredClone(root);
  let cursor = clone as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
  cursor[path[path.length - 1] as string | number] = value;
  return clone;
}

/**
 * A snapshot checksum only detects corruption; it is not an operator signature.
 * Every mutation below is therefore **re-sealed** with a freshly computed
 * `snapshotHash`, so what is under test is the semantic validation in
 * `RoundBook.restore` and `CommandLedger.install`, not the checksum.
 */
function reseal(snapshot: Json): RoundBookSnapshot {
  const { snapshotHash: _ignored, ...base } = snapshot;
  return { ...base, snapshotHash: snapshotHash(base) } as unknown as RoundBookSnapshot;
}

const game = constellationReference;
let valid: Json;

function publishedBinding(snapshot: Json): { roundId: string; commitment: string } {
  return snapshot.publishedRound as { roundId: string; commitment: string };
}

beforeAll(async () => {
  const seedHex = seed(31);
  const transcript = makeTranscript(seedHex, game, 'snapshot-mutation');
  const book = new RoundBook(game, initialPosterior(game), {
    roundId: transcript.context.roundId,
    commitment: transcript.commitment,
  });
  await book.open({
    idempotencyKey: 'open',
    expectedFrameRevision: 0,
    outcome: transcript.truth,
    stake: 1000n,
  });
  const sold = await book.sell({ idempotencyKey: 'sell', expectedFrameRevision: 0 });
  expect(sold.credited).toBeGreaterThan(0n);
  await book.open({
    idempotencyKey: 'reopen',
    expectedFrameRevision: 0,
    outcome: transcript.truth,
    stake: sold.credited,
  });
  for (const event of transcript.evidence.slice(0, 3)) await book.advanceFrame(event);
  valid = JSON.parse(book.serialize()) as Json;
  expect(valid.position).not.toBeNull();
  expect((valid.receipts as unknown[]).length).toBe(3);
});

describe('re-sealed snapshot mutations are rejected on their merits', () => {
  it('accepts the unmutated re-sealed snapshot', () => {
    expect(() => RoundBook.restore(game, reseal(valid), publishedBinding(valid))).not.toThrow();
  });

  const bump = (value: unknown): unknown =>
    typeof value === 'number' ? value + 1 : String(BigInt(value as string) + 1n);

  const cases: readonly (readonly [
    string,
    readonly (string | number)[],
    (v: unknown) => unknown,
  ])[] = [
    ['adapter id', ['adapter', 'id'], () => 'other-adapter'],
    ['adapter version', ['adapter', 'version'], () => '9.9.9'],
    ['adapter fingerprint', ['adapter', 'fingerprint'], () => 'ab'.repeat(32)],
    ['frame revision', ['frameRevision'], bump],
    ['ledger revision', ['ledgerRevision'], bump],
    ['entry count', ['entryCount'], bump],
    ['cap basis stake', ['capBasisStake'], bump],
    ['liquid balance', ['liquidBalance'], bump],
    ['terminal flag', ['terminal'], (v) => !(v as boolean)],
    ['posterior weight', ['posterior', 'weights', 0], bump],
    ['posterior total', ['posterior', 'total'], bump],
    ['evidence index', ['evidence', 0, 'index'], bump],
    ['evidence target', ['evidence', 0, 'target'], (v) => ((v as number) + 1) % 3],
    ['evidence favour', ['evidence', 0, 'favour'], bump],
    ['evidence other', ['evidence', 0, 'other'], bump],
    ['position stake', ['position', 'stake'], bump],
    [
      'position outcome',
      ['position', 'outcome'],
      (v) => ((v as number) + 1) % game.outcomes.length,
    ],
    ['position payout numerator', ['position', 'contingentPayout', 'numerator'], bump],
    ['position payout denominator', ['position', 'contingentPayout', 'denominator'], bump],
    ['position cap basis', ['position', 'capBasisStake'], bump],
    ['position entry count', ['position', 'entryCount'], bump],
    ['position opened-at revision', ['position', 'openedAtFrameRevision'], () => 99],
    ['receipt fingerprint', ['receipts', 0, 'fingerprint'], () => 'cd'.repeat(32)],
    [
      'reused receipt idempotency key',
      ['receipts', 1, 'receipt', 'idempotencyKey'],
      () => readAt(valid, ['receipts', 0, 'receipt', 'idempotencyKey']),
    ],
    ['receipt schema', ['receipts', 0, 'receipt', 'schema'], () => 'reveal-engine/receipt-v2'],
    ['receipt action', ['receipts', 0, 'receipt', 'action'], () => 'sell'],
    ['receipt ledger revision', ['receipts', 0, 'receipt', 'ledgerRevision'], bump],
    ['receipt frame revision', ['receipts', 0, 'receipt', 'frameRevision'], () => 99],
    ['receipt debited', ['receipts', 0, 'receipt', 'debited'], bump],
    ['receipt credited', ['receipts', 1, 'receipt', 'credited'], bump],
    ['receipt balance delta', ['receipts', 1, 'receipt', 'balanceDelta'], bump],
  ];

  it.each(cases)('rejects a re-sealed mutation of the %s', (_label, path, mutate) => {
    const mutated = reseal(writeAt(valid, path, mutate(readAt(valid, path))));
    expect(() => RoundBook.restore(game, mutated, publishedBinding(valid))).toThrowError(
      expect.objectContaining({
        code: expect.stringMatching(
          /^(INVALID_SNAPSHOT|ADAPTER_MISMATCH|INVALID_(EVIDENCE|POSTERIOR|RATIONAL))$/u,
        ),
      }),
    );
  });

  it('rejects added, removed, and reordered structural fields', () => {
    expect(() =>
      RoundBook.restore(game, reseal({ ...valid, extra: 1 }), publishedBinding(valid)),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
    const { terminal: _dropped, ...missing } = valid;
    expect(() => RoundBook.restore(game, reseal(missing), publishedBinding(valid))).toThrowError(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT' }),
    );
    const receipts = structuredClone(valid.receipts) as unknown[];
    expect(() =>
      RoundBook.restore(
        game,
        reseal({ ...valid, receipts: [...receipts].reverse() }),
        publishedBinding(valid),
      ),
    ).not.toThrow();
    expect(() =>
      RoundBook.restore(
        game,
        reseal({ ...valid, receipts: receipts.slice(0, 2) }),
        publishedBinding(valid),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  /**
   * `position.outcome` and `position.contingentPayout` are the two money-bearing
   * position fields that no other snapshot field implies. Both are re-derived in
   * `restore()` — the outcome from the open receipt's `commandFingerprint`, the
   * payout from the price replayed at the frame the position was opened at — so
   * these two cases pin the settlement each attack was reaching for, not just
   * the fact that restore throws.
   */
  it('refuses a re-sealed snapshot whose position was moved onto the winning outcome', async () => {
    const seedHex = seed(0x1f);
    const transcript = makeTranscript(seedHex, game, 'outcome-rewrite');
    const losing = (transcript.truth + 1) % game.outcomes.length;
    const binding = { roundId: transcript.context.roundId, commitment: transcript.commitment };
    const book = new RoundBook(game, initialPosterior(game), binding);
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 0,
      outcome: losing,
      stake: 1000n,
    });
    for (const event of transcript.evidence) await book.advanceFrame(event);
    const honest = JSON.parse(book.serialize()) as Json;

    // What the honest book is worth: a losing position settles for nothing.
    const settled = await RoundBook.restore(game, reseal(honest), binding).settle({
      idempotencyKey: 'settle',
      expectedFrameRevision: transcript.evidence.length,
      revealedSeed: seedHex,
      transcript,
    });
    expect(settled.credited).toBe(0n);

    const moved = writeAt(honest, ['position', 'outcome'], transcript.truth);
    expect(() => RoundBook.restore(game, reseal(moved), binding)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT', path: '$.position.outcome' }),
    );
  });

  it('refuses a re-sealed snapshot whose contingent payout was inflated', async () => {
    const seedHex = seed(0x1f);
    const transcript = makeTranscript(seedHex, game, 'payout-inflation');
    const binding = { roundId: transcript.context.roundId, commitment: transcript.commitment };
    const book = new RoundBook(game, initialPosterior(game), binding);
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 0,
      outcome: transcript.truth,
      stake: 1000n,
    });
    for (const event of transcript.evidence) await book.advanceFrame(event);
    const honest = JSON.parse(book.serialize()) as Json;

    const settled = await RoundBook.restore(game, reseal(honest), binding).settle({
      idempotencyKey: 'settle',
      expectedFrameRevision: transcript.evidence.length,
      revealedSeed: seedHex,
      transcript,
    });
    // The honest claim is worth a fraction of the ceiling the inflation reaches for.
    expect(settled.credited).toBeGreaterThan(0n);
    expect(settled.credited).toBeLessThan(1000n * game.risk.maxWinMultiple);

    const path = ['position', 'contingentPayout', 'numerator'] as const;
    const inflated = writeAt(honest, path, String(BigInt(readAt(honest, path) as string) * 1000n));
    expect(() => RoundBook.restore(game, reseal(inflated), binding)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT', path: '$.position.contingentPayout' }),
    );
  });

  it('still rejects a mutation that was not re-sealed', () => {
    expect(() =>
      RoundBook.restore(
        game,
        writeAt(valid, ['liquidBalance'], '999') as never,
        publishedBinding(valid),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  it('rejects coordinated historical sell and re-entry credits after replaying the price', () => {
    const forged = structuredClone(valid);
    const binding = forged.publishedRound as { roundId: string; commitment: string };
    const history = forged.openHistory as Json[];
    const position = forged.position as Json;
    const receipts = forged.receipts as { fingerprint: string; receipt: Json }[];
    const sell = receipts[1] as { fingerprint: string; receipt: Json };
    const reopen = receipts[2] as { fingerprint: string; receipt: Json };
    const original = BigInt(sell.receipt.credited as string);
    const invented = original + 1n;
    const outcome = position.outcome as number;
    const payout = multiply(
      rational(invented),
      quote(game, initialPosterior(game), outcome, false, 0).multiplier,
    );
    const reopenFingerprint = commandFingerprint('open', [
      binding.roundId,
      binding.commitment,
      0,
      outcome,
      invented,
    ]);

    sell.receipt.credited = String(invented);
    sell.receipt.balanceDelta = String(invented);
    reopen.fingerprint = reopenFingerprint;
    reopen.receipt.commandFingerprint = reopenFingerprint;
    reopen.receipt.debited = String(invented);
    reopen.receipt.balanceDelta = String(-invented);
    position.stake = String(invented);
    position.contingentPayout = toWireRational(payout);
    (history[1] as Json).stake = String(invented);
    (history[1] as Json).contingentPayout = toWireRational(payout);

    expect(() => RoundBook.restore(game, reseal(forged), binding)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_SNAPSHOT',
        message: 'Historical sell credit does not re-derive',
      }),
    );
  });
});

/**
 * The exposure `PermutationBook.restore()` does NOT close, executed rather than
 * disclosed in prose.
 *
 * These two tests assert that a forged snapshot is **accepted**, which is not a
 * thing a test suite should normally do. They are here because the alternative
 * was worse: `round-book.ts` claimed that "a rewritten ticket cannot survive its
 * own log", `docs/modules/permutation.md` §12 and `docs/threat-model.md`
 * described the residual as a whole-round re-point, and
 * `docs/integration-checklist.md` offered the published-round argument as the
 * control. All four were wrong in the same direction, and nothing ran.
 *
 * `commandFingerprint` is an unkeyed SHA-256 over public fields and it is an
 * export of this package. A forger with write access to the snapshot store
 * therefore rewrites the receipt log alongside the ticket, and every
 * re-derivation `restore()` performs is a consistency check over bytes the
 * forger supplied. The published round — passed correctly in both tests below —
 * is orthogonal: it pins which round, never which ticket.
 *
 * If someone later closes this by adding authentication, these tests fail. That
 * is the point: the failure is the prompt to update `docs/modules/permutation.md`
 * §9.2, the threat model row and the checklist item, so the disclosure and the
 * code cannot drift apart again.
 */
describe('permutation snapshot forgery is not detectable in process', () => {
  const permutationGame = aetherOrderClassicReference;

  async function honestSettledRound(roundId: string) {
    const seedHex = createHash('sha256').update(roundId).digest('hex');
    const transcript = makePermutationTranscript(seedHex, permutationGame, roundId);
    const binding = { roundId, commitment: transcript.commitment };
    const book = new PermutationBook(permutationGame, binding);
    await book.place({
      idempotencyKey: 'honest',
      bet: { code: 'first', item: transcript.order[0] as number },
      stake: 25n,
    });
    const settled = await book.settle({
      idempotencyKey: 'settle',
      revealedSeed: seedHex,
      transcript,
    });
    return { binding, book, settled, snapshot: JSON.parse(book.serialize()) as Json, transcript };
  }

  it('accepts a snapshot carrying a 5,000-chip line that was never placed', async () => {
    const { binding, settled, snapshot, transcript } = await honestSettledRound('forge-add');
    expect(settled.credited).toBe(120n);

    // FULL ORDER on the settled order at 5,000 chips: 5000 * 576/5 = 576,000.
    const forgedOrder = [...transcript.order];
    const forgedStake = 5_000n;
    const forgedFingerprint = commandFingerprint('place', [
      binding.roundId,
      binding.commitment,
      'full',
      ...forgedOrder,
      forgedStake,
    ]);
    const receipts = snapshot.receipts as { fingerprint: string; receipt: Json }[];
    const settleEntry = receipts[receipts.length - 1] as { fingerprint: string; receipt: Json };
    const credited = 120n + 576_000n;

    const forged: Json = {
      ...snapshot,
      claims: [
        ...(snapshot.claims as Json[]).slice(0, 1),
        { key: 'forged', code: 'full', parameters: forgedOrder, stake: String(forgedStake) },
      ],
      receipts: [
        receipts[0],
        {
          fingerprint: forgedFingerprint,
          receipt: {
            schema: PERMUTATION_RECEIPT_SCHEMA,
            idempotencyKey: 'forged',
            commandFingerprint: forgedFingerprint,
            action: 'place',
            ledgerRevision: 2,
            frameRevision: 0,
            debited: String(forgedStake),
            credited: '0',
            balanceDelta: String(-forgedStake),
            capped: false,
          },
        },
        {
          fingerprint: settleEntry.fingerprint,
          receipt: {
            ...settleEntry.receipt,
            ledgerRevision: 3,
            credited: String(credited),
            balanceDelta: String(credited),
          },
        },
      ],
      capBasisStake: String(25n + forgedStake),
      liquidBalance: String(credited),
      ledgerRevision: 3,
    };
    const { snapshotHash: _drop, ...base } = forged;
    const sealed = { ...base, snapshotHash: snapshotHash(base) };

    // The correct published round, read from outside the rewritten store. It
    // does not help, and the documentation used to say it did.
    const restored = PermutationBook.restore(permutationGame, sealed, binding);
    expect(restored.claims.length).toBe(2);
    expect(restored.liquidBalance).toBe(576_120n);
    expect(restored.stakedTotal).toBe(5_025n);
  });

  it('accepts a snapshot with a placed line deleted from it', async () => {
    const roundId = 'forge-drop';
    const seedHex = createHash('sha256').update(roundId).digest('hex');
    const transcript = makePermutationTranscript(seedHex, permutationGame, roundId);
    const binding = { roundId, commitment: transcript.commitment };
    const book = new PermutationBook(permutationGame, binding);
    await book.place({
      idempotencyKey: 'kept',
      bet: { code: 'first', item: transcript.order[0] as number },
      stake: 25n,
    });
    await book.place({
      idempotencyKey: 'dropped',
      bet: { code: 'last', item: transcript.order[4] as number },
      stake: 5_000n,
    });
    await book.settle({ idempotencyKey: 'settle', revealedSeed: seedHex, transcript });
    const snapshot = JSON.parse(book.serialize()) as Json;
    const receipts = snapshot.receipts as { fingerprint: string; receipt: Json }[];
    const settleEntry = receipts[receipts.length - 1] as { fingerprint: string; receipt: Json };

    const credited = 120n;
    const forged: Json = {
      ...snapshot,
      claims: (snapshot.claims as Json[]).slice(0, 1),
      receipts: [
        receipts[0],
        {
          fingerprint: settleEntry.fingerprint,
          receipt: {
            ...settleEntry.receipt,
            ledgerRevision: 2,
            credited: String(credited),
            balanceDelta: String(credited),
          },
        },
      ],
      capBasisStake: '25',
      liquidBalance: String(credited),
      ledgerRevision: 2,
    };
    const { snapshotHash: _drop, ...base } = forged;
    const sealed = { ...base, snapshotHash: snapshotHash(base) };

    const restored = PermutationBook.restore(permutationGame, sealed, binding);
    expect(restored.claims.length).toBe(1);
    expect(restored.stakedTotal).toBe(25n);
  });
});

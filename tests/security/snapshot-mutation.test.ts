import { beforeAll, describe, expect, it } from 'vitest';
import { snapshotHash } from '../../src/core/snapshot.js';
import { initialPosterior } from '../../src/modules/progressive-market/posterior.js';
import { makeTranscript } from '../../src/modules/progressive-market/fairness.js';
import {
  RoundBook,
  type RoundBookSnapshot,
} from '../../src/modules/progressive-market/round-book.js';
import { constellationReference } from '../../src/modules/progressive-market/references/index.js';
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

beforeAll(async () => {
  const seedHex = seed(31);
  const transcript = makeTranscript(seedHex, game, 'snapshot-mutation');
  const book = new RoundBook(game, initialPosterior(game));
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
    expect(() => RoundBook.restore(game, reseal(valid))).not.toThrow();
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
    ['position cap basis', ['position', 'capBasisStake'], bump],
    ['position entry count', ['position', 'entryCount'], bump],
    ['position opened-at revision', ['position', 'openedAtFrameRevision'], () => 99],
    ['receipt fingerprint', ['receipts', 0, 'fingerprint'], () => 'cd'.repeat(32)],
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
    expect(() => RoundBook.restore(game, mutated)).toThrowError(
      expect.objectContaining({
        code: expect.stringMatching(
          /^(INVALID_SNAPSHOT|ADAPTER_MISMATCH|INVALID_(EVIDENCE|POSTERIOR|RATIONAL))$/u,
        ),
      }),
    );
  });

  it('rejects added, removed, and reordered structural fields', () => {
    expect(() => RoundBook.restore(game, reseal({ ...valid, extra: 1 }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT' }),
    );
    const { terminal: _dropped, ...missing } = valid;
    expect(() => RoundBook.restore(game, reseal(missing))).toThrowError(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT' }),
    );
    const receipts = structuredClone(valid.receipts) as unknown[];
    expect(() =>
      RoundBook.restore(game, reseal({ ...valid, receipts: [...receipts].reverse() })),
    ).not.toThrow();
    expect(() =>
      RoundBook.restore(game, reseal({ ...valid, receipts: receipts.slice(0, 2) })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  it('still rejects a mutation that was not re-sealed', () => {
    expect(() =>
      RoundBook.restore(game, writeAt(valid, ['liquidBalance'], '999') as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });
});

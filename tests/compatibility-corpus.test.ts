import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compatibilityCorpusDigest,
  compareCompatibilityCorpus,
  parseCompatibilityCorpus,
} from '../src/compatibility/index.js';
import { ENGINE_LIMITS } from '../src/api/limits.js';
import { makeTranscript } from '../src/core/fairness.js';
import { initialPosterior } from '../src/core/posterior.js';
import { RoundBook } from '../src/protocol/round-book.js';
import { blackSignalReference, constellationReference } from '../src/reference/index.js';

const corpusPath = new URL('../compatibility-corpora/black-signal-v1.json', import.meta.url);
const fixture = readFileSync(corpusPath, 'utf8');

type MutableCorpus = Record<string, any>;

function mutableCorpus(): MutableCorpus {
  return JSON.parse(fixture) as MutableCorpus;
}

function reseal(corpus: MutableCorpus): string {
  corpus.integrity.sha256 = compatibilityCorpusDigest(corpus);
  return JSON.stringify(corpus);
}

function recomputeObserved(corpus: MutableCorpus): void {
  const cases = corpus.vectors.flatMap((vector: MutableCorpus) => vector.economics);
  const sellDeltas = cases.map(
    (item: MutableCorpus) => BigInt(item.targetSellCents) - BigInt(item.hostSellCents),
  );
  const settlementDeltas = cases.map(
    (item: MutableCorpus) =>
      BigInt(item.targetWinningSettlementCents) - BigInt(item.hostWinningSettlementCents),
  );
  corpus.observed.sellExactMatches = sellDeltas.filter((delta: bigint) => delta === 0n).length;
  corpus.observed.sellExpectedDeltas = sellDeltas.filter((delta: bigint) => delta !== 0n).length;
  corpus.observed.settlementExactMatches = settlementDeltas.filter(
    (delta: bigint) => delta === 0n,
  ).length;
  corpus.observed.settlementExpectedDeltas = settlementDeltas.filter(
    (delta: bigint) => delta !== 0n,
  ).length;
  corpus.observed.maxSellDeltaCents = sellDeltas
    .reduce((maximum: bigint, delta: bigint) => {
      const absolute = delta < 0n ? -delta : delta;
      return absolute > maximum ? absolute : maximum;
    }, 0n)
    .toString();
  corpus.observed.maxSettlementDeltaCents = settlementDeltas
    .reduce((maximum: bigint, delta: bigint) => {
      const absolute = delta < 0n ? -delta : delta;
      return absolute > maximum ? absolute : maximum;
    }, 0n)
    .toString();
}

describe('versioned compatibility corpus and shadow comparison', () => {
  it('pins the read-only source provenance and exact bounded audit findings', () => {
    const corpus = parseCompatibilityCorpus(fixture);
    expect(corpus.schema).toBe('reveal-engine/compatibility-corpus-v1');
    expect(corpus.source).toMatchObject({
      repository: 'metaforismo/blacksignal',
      branch: 'v8-signal-identity',
      revision: '7c63ebae28756df3b0ae96b917db37791cfcc588',
      observedDirtyState: [' D black_signal_dossier.pdf', '?? .claude/'],
    });
    expect(corpus.sampling).toMatchObject({ seedCount: 64, economicCaseCount: 4096 });
    expect(corpus.observed).toEqual({
      truthMatches: 18,
      evidenceScheduleMatches: 0,
      sellExactMatches: 2914,
      sellExpectedDeltas: 1182,
      settlementExactMatches: 4082,
      settlementExpectedDeltas: 14,
      maxSellDeltaCents: '1',
      maxSettlementDeltaCents: '1',
    });
  });

  it('replays deterministically and exposes every expected economic delta', () => {
    const first = compareCompatibilityCorpus(blackSignalReference, fixture);
    const second = compareCompatibilityCorpus(blackSignalReference, fixture);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      activationReady: false,
      checked: { vectors: 64, posteriorCheckpoints: 256, economicCases: 4096, capCases: 4 },
      classifications: {
        'expected-migration-delta': 1370,
        'host-managed': 1,
        'unexpected-delta': 0,
        'target-drift': 0,
      },
    });
    const sells = first.findings.filter((finding) => finding.field === 'liquidation');
    const settlements = first.findings.filter((finding) => finding.field === 'winning-settlement');
    expect(sells).toHaveLength(1182);
    expect(settlements).toHaveLength(14);
    expect([...sells, ...settlements].every((finding) => finding.deltaCents === '1')).toBe(true);
  }, 15_000);

  it('rejects byte-level tamper, unknown fields, and malformed frozen host evidence', () => {
    const tampered = mutableCorpus();
    tampered.observed.truthMatches += 1;
    expect(() => parseCompatibilityCorpus(JSON.stringify(tampered))).toThrowError(
      expect.objectContaining({ code: 'COMPATIBILITY_INTEGRITY_MISMATCH' }),
    );

    const unknown = mutableCorpus();
    unknown.undocumentedTolerance = true;
    expect(() => parseCompatibilityCorpus(reseal(unknown))).toThrowError(
      expect.objectContaining({ code: 'INVALID_COMPATIBILITY_CORPUS' }),
    );

    const evidenceTamper = mutableCorpus();
    evidenceTamper.vectors[0].host.evidence[0].target =
      (evidenceTamper.vectors[0].host.evidence[0].target + 1) % 4;
    expect(() => parseCompatibilityCorpus(reseal(evidenceTamper))).toThrowError(
      expect.objectContaining({ code: 'INVALID_COMPATIBILITY_CORPUS' }),
    );
  });

  it('classifies malformed seeds as corpus errors and bounds in-memory objects', () => {
    const badSeed = mutableCorpus();
    badSeed.vectors[0].seed = 'z'.repeat(64);
    expect(() => parseCompatibilityCorpus(reseal(badSeed))).toThrowError(
      expect.objectContaining({ code: 'INVALID_COMPATIBILITY_CORPUS' }),
    );
    expect(() =>
      parseCompatibilityCorpus({
        oversized: 'x'.repeat(ENGINE_LIMITS.maxCompatibilityCorpusBytes + 1),
      }),
    ).toThrowError(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
  });

  it('cannot hide unexplained money changes behind a valid integrity digest', () => {
    const corpus = mutableCorpus();
    const economicCase = corpus.vectors
      .flatMap((vector: MutableCorpus) => vector.economics)
      .find(
        (item: MutableCorpus) =>
          item.hostSellCents === item.targetSellCents && BigInt(item.targetSellCents) >= 2n,
      );
    expect(economicCase).toBeDefined();
    economicCase.hostSellCents = (BigInt(economicCase.targetSellCents) - 2n).toString();
    recomputeObserved(corpus);
    const report = compareCompatibilityCorpus(blackSignalReference, reseal(corpus));
    expect(report.ok).toBe(false);
    expect(report.classifications['unexpected-delta']).toBe(1);
    expect(
      report.findings.some(
        (finding) => finding.classification === 'unexpected-delta' && finding.deltaCents === '2',
      ),
    ).toBe(true);
  });

  it('detects frozen target drift even when an attacker recomputes corpus integrity', () => {
    const corpus = mutableCorpus();
    corpus.vectors[0].target.commitment = '0'.repeat(64);
    const report = compareCompatibilityCorpus(blackSignalReference, reseal(corpus));
    expect(report.ok).toBe(false);
    expect(report.classifications['target-drift']).toBe(1);
  });

  it('rejects a resealed corpus contract that no longer matches the adapter', () => {
    const corpus = mutableCorpus();
    corpus.contract.maxWinMultiple = '5001';
    const report = compareCompatibilityCorpus(blackSignalReference, reseal(corpus));
    expect(report.ok).toBe(false);
    expect(
      report.findings.some(
        (finding) =>
          finding.field === 'max-win-cap' && finding.classification === 'unexpected-delta',
      ),
    ).toBe(true);
  });

  it('rejects cross-adapter replay before evaluating economic vectors', () => {
    expect(() => compareCompatibilityCorpus(constellationReference, fixture)).toThrowError(
      expect.objectContaining({ code: 'ADAPTER_MISMATCH' }),
    );
  });

  it('keeps reference-protocol retries idempotent while the cap corpus remains exact', async () => {
    expect(parseCompatibilityCorpus(fixture).capCases).toHaveLength(4);
    const seed = '47'.padStart(64, '0');
    const transcript = makeTranscript(seed, blackSignalReference, 'compat-idempotency');
    const book = new RoundBook(blackSignalReference, initialPosterior(blackSignalReference));
    const request = {
      idempotencyKey: 'compat-open',
      expectedFrameRevision: 0,
      outcome: transcript.truth,
      stake: 100n,
    } as const;
    const first = await book.open(request);
    expect(await book.open(request)).toBe(first);
    for (const event of transcript.evidence) await book.advanceFrame(event);
    const settle = {
      idempotencyKey: 'compat-settle',
      expectedFrameRevision: transcript.evidence.length,
      revealedSeed: seed,
      transcript,
    } as const;
    const receipt = await book.settle(settle);
    expect(await book.settle(settle)).toBe(receipt);
    expect(book.ledgerRevision).toBe(2);
  });
});

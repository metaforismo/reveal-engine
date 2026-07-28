# Reveal Engine™

Private, proprietary progressive-reveal game technology from **Axiom Games**.

The first reference integration is **BLACK SIGNAL**:

> BLACK SIGNAL — Powered by Reveal Engine™ — An Axiom Games original

Reveal Engine™ is technology, BLACK SIGNAL is a title, and Axiom Games is the studio. The repository contains no BLACK SIGNAL art, UI, story, or player-facing copy. The ™ symbol is not a registered-trademark claim.

## What is stable in 0.3

- `reveal-engine/api-v1`: adapter, posterior, pricing, proof, error, and protocol contracts;
- exact normalized `bigint` rational arithmetic through the payable credit boundary;
- deterministic prior-weighted truth derivation and symmetric Bayesian evidence updates;
- `reveal-engine/commit-v2`: length-prefixed canonical encoding, adapter fingerprint binding, domain-separated rejection sampling, and typed verification;
- `reveal-engine/transcript-v2`, `receipt-v1`, and `round-book-v1` JSON-safe wire contracts;
- frame-fenced, action-bound idempotent protocol operations with exact claims, original cap basis, replayable receipts, and reconnect snapshots;
- mechanical adapter conformance plus three fixtures: four-outcome BLACK SIGNAL compatibility, a non-uniform three-outcome synthetic game, and a minimal binary fixture.
- `compatibility-corpus-v1`: provenance-locked shadow replay, strict integrity/semantic validation, target-drift detection, explicit migration-delta reporting, and a bounded BLACK SIGNAL corpus.

Legacy `commit-v1` is verification-only. New rounds must use `commit-v2`.

## Quick start

```ts
import {
  binaryBeaconReference,
  initialPosterior,
  makeTranscript,
  RoundBook,
} from '@axiom-games/reveal-engine';

const seed = '01'.padStart(64, '0');
const transcript = makeTranscript(seed, binaryBeaconReference, 'round-42');
const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference));

await book.open({
  idempotencyKey: 'player-action-1',
  expectedFrameRevision: 0,
  outcome: 0,
  stake: 100n,
});
for (const event of transcript.evidence) await book.advanceFrame(event);
await book.settle({
  idempotencyKey: 'settlement-1',
  expectedFrameRevision: book.frame.revision,
  revealedSeed: seed,
  transcript,
});
```

## Verification commands

```sh
npm run verify
npm run test:coverage
npm run test:security
npm run compatibility
npm run artifacts:update   # intentional baseline refresh only
```

`reveal-verify` verifies a revealed transcript. `reveal-conformance` checks the bundled adapters. `reveal-compatibility` replays a frozen host corpus and refuses to hide unexpected economic deltas. Routine stress and benchmark runs write ignored files under `artifacts/runtime/`; tracked baselines change only through `artifacts:update`.

## Documentation path

Start with [architecture](docs/architecture.md), then [API reference](docs/api-reference.md), [compatibility corpus](docs/compatibility-corpus.md), [integration checklist](docs/integration-checklist.md), and [versioning](docs/versioning.md). Mathematical and security claims are bounded by [math assumptions](docs/math.md), [threat model](docs/threat-model.md), [certification boundary](docs/certification-boundary.md), and the [evidence ledger](docs/evidence-ledger.md).

This package is `private`, `UNLICENSED`, and unpublished. Tests and synthetic benchmarks are engineering evidence, not production capacity, RTP certification, regulatory approval, or a fairness certificate.

# Reveal Engine™

Private, proprietary progressive-reveal game technology from **Axiom Games**.

The first reference integration is **BLACK SIGNAL**:

> BLACK SIGNAL — Powered by Reveal Engine™ — An Axiom Games original

Reveal Engine™ is not BLACK SIGNAL and carries no game UI, art, narrative, marketing, or player-facing content. The ™ marks are not assertions of registered-trademark status.

## What it provides

- exact `bigint` rational Bayesian posteriors for any finite outcome set;
- deterministic, rejection-sampled seed derivation and versioned domain-separated commitments;
- first-entry RTP pricing, unshaded re-entry, fair-value liquidation, explicit rounding, and credit-boundary max-win caps;
- an integration-oriented state machine with frame fencing and idempotent receipts;
- two intentionally different reference configurations: a four-outcome BLACK SIGNAL compatibility adapter and a synthetic three-outcome constellation game;
- an independent CLI verifier, bounded stress harness, and machine-readable benchmark artifact.

## Quick start

```ts
import { constellationReference, initialPosterior, quote } from '@axiom-games/reveal-engine';
const posterior = initialPosterior(constellationReference);
const price = quote(constellationReference, posterior, 0, true, 0);
```

Run `npm run verify`; `npm run bench` writes `artifacts/benchmark.json`. Use `reveal-verify transcript.json revealed-seed-hex` after a round reveals.

## Read next

- [Architecture](docs/architecture.md) and [API contract](docs/api-contract.md)
- [Math assumptions](docs/math.md) and [threat model](docs/threat-model.md)
- [Integration guide](docs/integration.md), [BLACK SIGNAL adoption](docs/black-signal-migration.md), and [certification boundary](docs/certification-boundary.md)
- [Evidence ledger](docs/evidence-ledger.md), [contributing](CONTRIBUTING.md), and [security](SECURITY.md)

No package publication, public release, or certification is implied or authorized.

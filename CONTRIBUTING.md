# Contributing

This is a private proprietary repository. Do not add third-party game assets, title content, operator/player data, seeds, credentials, or code copied from game repositories.

Any math, adapter, proof, wire, receipt, or snapshot change requires an explicit versioning decision, a regression/compatibility fixture, conformance, and the full `npm run verify` stack. Refresh tracked stress/benchmark baselines only with `npm run artifacts:update` in an evidence-specific commit; ordinary fixes must not churn timing artifacts.

The frozen wire fixtures under `tests/fixtures/` are regenerated only with `npm run fixtures:update`, and only when the wire format is deliberately changing. A diff there in an ordinary pull request means an encoding changed by accident, which is exactly what those files exist to catch. The same applies to the stress `correctnessDigest`: it is compared against `artifacts/stress-v2.json` on every run, and a mismatch means replay-visible behaviour moved.

New lifecycle modules follow the checklist in [`docs/lifecycle-modules.md`](docs/lifecycle-modules.md).

Do not merge, publish, announce, or alter repository visibility/protection without explicit owner approval.

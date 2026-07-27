# Evidence ledger

Evidence below is repository-level engineering evidence from 2026-07-27. It does not cross the certification boundary.

| Claim / control                                                                              | Reproducible evidence                                                       | Observed result                                                                |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Stable API, strict codecs, fixtures, exact math, protocol, replay, races, and hostile inputs | `npm test`                                                                  | 11 files / 106 tests passed                                                    |
| Independent probability, pricing, strategy, rounding, cap, and accounting oracles            | `tests/math-oracle-invariants.test.ts`, `tests/protocol-accounting.test.ts` | exhaustive binary paths plus three-adapter raw-weight checks passed            |
| Deterministic property/metamorphic coverage                                                  | `tests/property-metamorphic.test.ts`                                        | 32 fixed property seeds and 256 replay/isolation cases passed                  |
| Proof vectors, migrations, tamper taxonomy, and hostile request validation                   | `npm run test:security`                                                     | 23 focused tests passed; runtime dependency audit found 0 vulnerabilities      |
| Coverage gate                                                                                | `npm run test:coverage`                                                     | statements 82.76%, branches 78.37%, functions 95.00%, lines 84.37%             |
| Adapter generality and conformance                                                           | `npm run conformance`                                                       | 3 materially different adapters, 16 seeds and 16 verified transcripts each     |
| Build and package surface                                                                    | `npm run typecheck && npm run build && npm run test:package`                | 8 explicit import surfaces; 59 packed files; no source/tests shipped           |
| Seeded protocol stress                                                                       | `scripts/stress.ts`, `artifacts/stress-v2.json`                             | 500 rounds / 4,334 operations; schema and loose thresholds passed              |
| Transcript/posterior/proof benchmark                                                         | `scripts/benchmark.ts`, `artifacts/benchmark-v2.json`                       | 1,200 samples / 52,000 events; schema and loose thresholds passed              |
| Hosted GitHub Actions baseline before 0.2                                                    | run `30228158160`, baseline head `67d73ab`                                  | infrastructure-blocked: job had no steps and billing/spending-limit annotation |
| Production RGS, certification, regulatory approval, and production capacity                  | none                                                                        | not performed and not claimed                                                  |

Stress and benchmark figures are synthetic local/CI measurements. Machine, process state, and runtime affect timings; correctness digests and workload seeds are the replay anchors. Hosted Actions state must be read from GitHub: infrastructure blocking is neither a code pass nor a code failure.

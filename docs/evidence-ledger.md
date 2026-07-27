# Evidence ledger

| Claim / control                                    | Local evidence                                              | Status                      |
| -------------------------------------------------- | ----------------------------------------------------------- | --------------------------- |
| Exact posterior and pricing                        | `tests/core.test.ts`, `tests/exhaustive-invariance.test.ts` | automated local guard       |
| Transcript commitment / tamper detection           | `tests/core.test.ts`                                        | automated local guard       |
| FSM, stale frame, idempotency, cap bypass          | `tests/protocol.test.ts`                                    | automated local guard       |
| Fuzz-like arithmetic mutation checks               | `tests/property-and-mutation.test.ts`                       | automated local guard       |
| Bounded load check                                 | `scripts/stress.ts`, `artifacts/stress.json`                | generated locally / CI      |
| Performance baseline                               | `scripts/benchmark.ts`, `artifacts/benchmark.json`          | generated locally / CI      |
| Production RGS, certification, regulatory approval | none                                                        | not performed / not claimed |

CI status must be read from GitHub Actions; a blocked hosted runner is infrastructure evidence, not a code-pass claim.

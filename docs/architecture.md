# Architecture

| Layer               | Responsibility                                        | Deliberate boundary                            |
| ------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| `src/api`           | stable versions, limits, typed errors                 | no algorithms                                  |
| `src/core`          | exact math, adapters, posterior, truth/evidence proof | no player balance or presentation              |
| `src/protocol`      | frames, actions, receipts, cap/accounting, snapshots  | in-memory reference, not a production database |
| `src/serialization` | bounded JSON wire formats and migration               | untrusted input boundary                       |
| `src/conformance`   | mechanical adapter checks                             | evidence, not certification                    |
| `src/compatibility` | frozen-host corpus validation and shadow comparison   | never mutates a live round or title wallet     |
| `src/reference`     | three game configurations                             | no title UI/assets/content                     |
| `src/integration`   | illustrative RGS boundary                             | not production persistence                     |
| `src/cli`           | independent verifier/conformance tools                | revealed seeds only                            |

Exact values remain reduced rational BigInts. A position stores a rational contingent claim; only liquidation or settlement calls payable rounding/cap logic. The protocol keeps price-frame revision separate from receipt-ledger revision, so a duplicate action cannot create a stale price and a new frame cannot impersonate a money movement.

Each successful command is bound to its idempotency key by a canonical fingerprint. Exact retries replay their receipt; a changed payload or action fails with `IDEMPOTENCY_CONFLICT`. Failed operations do not mutate state. Snapshot restoration replays evidence, validates adapter identity, receipt ordering/accounting, cap state, and a deterministic snapshot checksum.

The checksum detects corruption and supports deterministic replay; it is not an operator signature. Production storage still requires authenticated records and a transaction around idempotency, debit/credit, state transition, and receipt append.

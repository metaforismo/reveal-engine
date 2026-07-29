# Versioning and migration policy

The npm package remains private and unpublished. Semver still communicates
repository compatibility.

| Identity         | Current                                 | Change rule                                         |
| ---------------- | --------------------------------------- | --------------------------------------------------- |
| Package          | `0.3.0`                                 | semver                                              |
| Engine API       | `reveal-engine/api-v1`                  | new value for a breaking runtime/type contract      |
| Module API       | `reveal-engine/module-v1`               | new value when the lifecycle-module contract breaks |
| Module           | module-owned                            | change for any replay-visible module behavior       |
| Definition       | definition-owned                        | change for any replay-visible configuration change  |
| Derivation model | definition-owned                        | change for any step-derivation behavior             |
| Commitment       | `commit-v2`                             | new rounds use current; v1 is verification-only     |
| Transcript       | module-owned, currently `transcript-v2` | bounded migration parser                            |
| Receipt          | `receipt-v1`                            | immutable money-movement record                     |
| Snapshot         | module-owned, currently `round-book-v1` | reject unknown versions                             |
| Seed commitment  | `commit-v2` domain `seed-commitment`    | published before a choice-timed round's first move  |

Migrations are pure, deterministic, and must keep a frozen fixture verifying. A
migration never invents a missing proof, definition version, receipt, or
economic field. Unsupported future versions fail closed.

Every schema in the table above has a committed fixture or a known-answer vector
under `tests/fixtures/`, rebuilt and compared field for field on every test run.
Regenerate them deliberately with `npm run fixtures:update`; a diff there is a
wire-format decision, not a refactor.

## Error-code taxonomy

`ERROR_CODES` is split by owner. The game-agnostic codes are what core and the
lifecycle-module contract raise; the progressive market's own vocabulary
(`INVALID_ADAPTER`, `ADAPTER_MISMATCH`, `INVALID_POSTERIOR`, `INVALID_EVIDENCE`,
`OPEN_REJECTED`, `SELL_REJECTED`, `SETTLE_REJECTED`) is retained because hosts
branch on it, and is not for new modules. A module with no adapter reports
`DEFINITION_MISMATCH` and `CLAIM_REJECTED`. `VerificationFailure['code']`
accepts both spellings of a definition mismatch for the same reason; adding a
code is additive, removing one is breaking.

Breaking public-export changes require updating the export snapshot test, the
API docs, the changelog, the fixtures, and the package version decision.

## 0.3.0 subpath changes

- Added: `./modules`, `./modules/progressive-market`.
- `./core` is now game-agnostic. Adapter, posterior, transcript, and book
  symbols moved to `./modules/progressive-market`.
- `./protocol`, `./serialization`, `./reference` are deprecated aliases that
  re-export the relocated implementation. They will be removed no earlier than
  the next minor release.
- The root export keeps its previous surface and adds the platform symbols, so
  existing root imports continue to work.

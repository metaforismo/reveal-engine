# Versioning and migration policy

The npm package remains private and unpublished. Semver still communicates repository compatibility.

| Identity       | Current                | Change rule                                  |
| -------------- | ---------------------- | -------------------------------------------- |
| Package        | `0.2.0`                | semver                                       |
| Engine API     | `reveal-engine/api-v1` | new value for breaking runtime/type contract |
| Adapter        | adapter-owned          | change for any replay-visible behavior       |
| Evidence model | adapter-owned          | change for derivation behavior               |
| Commitment     | `commit-v2`            | new rounds use current; v1 verification-only |
| Transcript     | `transcript-v2`        | bounded migration parser                     |
| Receipt        | `receipt-v1`           | immutable money-movement record              |
| Snapshot       | `round-book-v1`        | reconnect state; reject unknown versions     |

Migrations are pure, deterministic, and must preserve a frozen fixture. A migration never invents a missing proof, adapter version, receipt, or economic field. Unsupported future versions fail closed. Breaking public-export changes require updating the export snapshot, API docs, changelog, fixtures, and package major/version policy decision.

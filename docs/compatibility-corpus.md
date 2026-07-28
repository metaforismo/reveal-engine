# Compatibility and shadow corpus v1

`reveal-engine/compatibility-corpus-v1` is a strict JSON wire contract for replaying a host title's frozen behavior against one pinned engine adapter. It is an adoption bridge, not a migration switch, tolerance layer, or certification artifact.

## Public API and CLI

```ts
import {
  compareCompatibilityCorpus,
  parseCompatibilityCorpus,
} from '@axiom-games/reveal-engine/compatibility';

const corpus = parseCompatibilityCorpus(jsonOrObject);
const report = compareCompatibilityCorpus(gameDefinition, corpus);
```

The parser enforces exact object keys, canonical decimal strings, count/byte/BigInt limits, full Git and SHA-256 identities, approved field/reason pairs, sampling-grid cardinality, frozen host truth and delimiter-commitment replay, evidence indices, posterior/case coverage, aggregate consistency, and `sha256-canonical-json-v1` integrity. `COMPATIBILITY_INTEGRITY_MISMATCH` is distinct from `INVALID_COMPATIBILITY_CORPUS`.

```sh
reveal-compatibility corpus.json
reveal-compatibility corpus.json --json
reveal-compatibility corpus.json --adapter-module ./adapter.js --export game
```

The first form resolves a bundled reference by the corpus's pinned adapter ID. A future title can explicitly load its own local ESM adapter with `--adapter-module`; that module is trusted executable code and is never selected from corpus data.

The immutable BLACK SIGNAL corpus ships with the private package at the explicit JSON subpath `@axiom-games/reveal-engine/compatibility/corpora/black-signal-v1.json`. Consumers should resolve and read that export instead of copying the corpus into another repository. Its byte-level SHA-256 is `60c669a3e05ac6084e11d489c12f4344f0826f7deefe550a8ee457c266f5f5a1`.

## Exact schema shape

```text
schema, corpusId
source { repository, branch, revision, revisionDate, observedDirtyState,
         files[{path,sha256}], generator{name,version} }
target { engineApiVersion, packageVersion, adapterId, adapterVersion,
         adapterFingerprint, proofVersion, transcriptSchema }
hostContracts { truth, evidence, commitment, pricing, continuation }
contract { outcomes, priorWeights, firstEntryRtp, liquidationSpread,
           rounding, maxWinMultiple, continuation{maxRides,rtpFloor} }
policies[{field,expectation,reason,allowedDeltaCents?}]
sampling { seedCount, seedDerivation, roundIdTemplate, posteriorFrames,
           entryFrames, exitFrames, outcomes, stakesCents, economicCaseCount }
observed { truthMatches, evidenceScheduleMatches, sellExactMatches,
           sellExpectedDeltas, settlementExactMatches,
           settlementExpectedDeltas, maxSellDeltaCents,
           maxSettlementDeltaCents }
vectors[{ vectorId, seed, roundId,
          host{truth,evidence,commitment,posteriorCheckpoints},
          target{truth,evidenceSha256,commitment}, economics[] }]
capCases[]
integrity { algorithm, sha256 }
```

All money and rational components are canonical decimal strings. Every economic case stores both the host observation and frozen engine target. Comparison first checks the current engine against the frozen target (`target-drift`), then classifies host-versus-current behavior. Recomputing integrity cannot turn changed target economics into an accepted migration delta.

## Classification contract

| Field                               | Required policy                                         | Meaning                                                                             |
| ----------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `truth`                             | `expected-migration-delta / legacy-truth-derivation`    | legacy uint64 and engine-v2 domain-separated samplers remain distinct               |
| `evidence`                          | `expected-migration-delta / legacy-evidence-derivation` | frozen title events and target schedule digests are compared without substitution   |
| `commitment`                        | `expected-migration-delta / proof-version-upgrade`      | delimiter commitment and canonical `commit-v2` are never called equivalent          |
| `posterior`                         | `exact / none`                                          | identical projected evidence must produce identical exact weights                   |
| `liquidation`, `winning-settlement` | `expected-migration-delta / early-payable-rounding`     | every nonzero cent delta is emitted with host value, target value, and signed delta |
| `max-win-cap`, `continuation`       | `exact / none`                                          | no tolerance is available                                                           |
| `ride-lifecycle`                    | `host-managed / host-managed-continuation`              | offer expiry, wallet and cross-round chain state are outside this engine bridge     |

`report.ok` means no unexplained delta and no target drift. `report.activationReady` is stricter: it is false while any expected migration delta or host-managed field remains. A shadow-compatible report therefore does not authorize production activation.

## Pinned BLACK SIGNAL corpus

`compatibility-corpora/black-signal-v1.json` was generated read-only from `metaforismo/blacksignal` branch `v8-signal-identity`, revision `7c63ebae28756df3b0ae96b917db37791cfcc588`. It records hashes for the relevant config, math, fairness, stream, positions, ride, invariance test, V7 loop specification, and SIGNAL identity specification. UI, art, story, names, and copy are absent. The corpus targets the frozen 0.3.0 engine behavior; package 0.3.1 only makes those unchanged bytes available through an immutable package export.

The deterministic sampling contract is 64 counter-derived 32-byte seeds, round IDs `audit-{index}`, posterior frames 0/17/52/120, entry frames 0/17/52, exit frames 17/52/120 where exit is not earlier than entry, four outcomes, and stakes 333¢/1,000¢: 4,096 economic cases. The capture script fails if the source revision, branch, approved dirty state, RTP ladder, or observed audit totals drift.

Regenerate only from that read-only checkout:

```sh
npm run compatibility:capture -- --source /path/to/blacksignal
```

The corpus proves a reproducible shadow comparison. It does not prove that BLACK SIGNAL consumes this package, has migrated proofs/economics, or is certified.

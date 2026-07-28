# Public API reference

## Package surfaces

| Export                       | Purpose                                                |
| ---------------------------- | ------------------------------------------------------ |
| `@axiom-games/reveal-engine` | supported convenience API                              |
| `/api`                       | versions, limits, typed errors, adapter types          |
| `/core`                      | exact math, posterior, fairness, validation primitives |
| `/protocol`                  | `RoundBook` and receipt/request contracts              |
| `/serialization`             | transcript wire codec and migration                    |
| `/conformance`               | adapter conformance runner/report                      |
| `/integration`               | illustrative, non-durable RGS boundary                 |
| `/reference`                 | bundled reference configurations                       |
| `/compatibility`             | strict shadow corpus parser, digest, and comparison    |

No `internal` subpath is exported. The root export list has an executable snapshot test.

## Core lifecycle

1. `defineGame(definition)` validates, clones, and deep-freezes an adapter.
2. `makeTranscript(seed, game, roundId)` derives exactly one truth from priors, derives canonical evidence, and commits the full proof plus adapter fingerprint.
3. `initialPosterior(game)` and `updatePosterior(posterior, event)` maintain exact normalized weights bound to that adapter.
4. `quote()` returns an exact rational first-entry or unshaded re-entry multiplier.
5. `RoundBook` applies frames and actions serially. Open/sell requests carry `expectedFrameRevision`; settlement also carries the revealed seed and proof.
6. `serializeTranscript()` and `RoundBook.serialize()` provide JSON-safe persistence. `RoundBook.restore()` replays evidence and validates receipt accounting.

## Proof verification

`verifyTranscriptDetailed()` never exposes incidental parser/crypto exceptions. It returns either `{ok:true}` or a failure code:

- `INVALID_TRANSCRIPT`
- `UNSUPPORTED_VERSION`
- `ADAPTER_MISMATCH`
- `DERIVATION_FAILED`
- `TRANSCRIPT_MISMATCH`
- `COMMITMENT_MISMATCH`

`verifyTranscript()` is the boolean compatibility wrapper.

## Compatibility adoption

- `parseCompatibilityCorpus(input)` strictly validates byte/count/key/type limits, canonical values, integrity, frozen host proof replay, sampling coverage, and aggregates; it returns a deeply frozen `compatibility-corpus-v1`.
- `compareCompatibilityCorpus(game, input)` independently replays current target truth/evidence/commitment, projected host-evidence posteriors, pricing/settlement observations, and cap cases. It returns every non-exact finding in `compatibility-report-v1`.
- `compatibilityCorpusDigest(input)` hashes recursively key-sorted JSON without the top-level integrity field; `compatibilityEvidenceDigest(events)` hashes canonical evidence.
- `deriveMaxContinuations(roundRtp, rtpFloor)` derives the exact bounded continuation count. It is not a cross-round state machine.

`report.ok` excludes unexplained deltas and target drift. `report.activationReady` additionally requires that every declared policy be exact. See [compatibility corpus](compatibility-corpus.md) for the exact wire and classification contract.

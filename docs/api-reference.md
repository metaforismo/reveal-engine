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

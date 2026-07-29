# Public API reference

## Package surfaces

| Export                                      | Purpose                                                          |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `@axiom-games/reveal-engine`                | supported convenience API (core essentials + progressive market) |
| `/api`                                      | versions, limits, typed errors                                   |
| `/core`                                     | game-agnostic primitives and the lifecycle-module contract       |
| `/modules`                                  | module registry: `listModules`, `findModule`, `requireModule`    |
| `/modules/progressive-market`               | the progressive-market lifecycle module in full                  |
| `/conformance`                              | module conformance runner and reports                            |
| `/integration`                              | illustrative, non-durable RGS boundary                           |
| `/protocol`, `/serialization`, `/reference` | **deprecated** aliases into `/modules/progressive-market`        |

No `internal` subpath is exported, and no subpath exposes proof-construction
internals (`commitment`, `canonicalTranscriptBytes`, `encodeFields`). Every
surface above has an executable snapshot test in `tests/public-api.test.ts`.

## Round lifecycle (progressive market)

1. `defineGame(definition)` validates, clones, and deep-freezes an adapter.
2. `makeTranscript(seed, game, roundId)` derives exactly one truth from the
   priors, derives canonical evidence, and seals the proof together with the
   adapter fingerprint.
3. `initialPosterior(game)` and `updatePosterior(posterior, event)` maintain
   exact normalised weights bound to that adapter.
4. `quote()` returns an exact rational first-entry or unshaded re-entry
   multiplier.
5. `RoundBook` applies steps and commands serially. Open and sell requests carry
   `expectedFrameRevision`; settlement also carries the revealed seed and proof.
6. `serializeTranscript()` and `RoundBook.serialize()` provide JSON-safe
   persistence. `RoundBook.restore()` replays evidence and revalidates receipt
   accounting.

## Working through the module contract

```ts
import { requireModule } from '@axiom-games/reveal-engine/modules';

const lifecycle = requireModule('progressive-market');
lifecycle.definitions.identity(definition); // module/definition ids, versions, fingerprint
lifecycle.truth.kind; // 'scalar-index'
lifecycle.book.positions; // 'single'
lifecycle.book.settlement; // 'winner-takes-claim'
lifecycle.transcript.schema; // 'reveal-engine/transcript-v2'
lifecycle.verify(seed, definition, wire); // VerificationResult
```

`checkModuleConformance(module, definition, seeds)` returns a
`reveal-engine/module-conformance-v1` report for any module.
`checkAdapterConformance(game, seeds)` is the progressive-market view of the same
run and keeps the `reveal-engine/adapter-conformance-v1` shape.

## Proof verification

`verifyTranscriptDetailed()` never exposes incidental parser or crypto
exceptions. It returns either `{ok: true}` or a failure code:

- `INVALID_TRANSCRIPT`
- `UNSUPPORTED_VERSION`
- `DEFINITION_MISMATCH` — the game-agnostic code for "this proof belongs to
  another definition"
- `ADAPTER_MISMATCH` — the progressive market's older spelling of the same
  thing, retained because hosts branch on it
- `DERIVATION_FAILED`
- `TRANSCRIPT_MISMATCH`
- `COMMITMENT_MISMATCH`

`verifyTranscript()` is the boolean compatibility wrapper.

A module with `choiceTiming` other than `none` additionally publishes a seed
pre-commitment (`transcript.seedCommitment`) before the round accepts a
decision, and its verifier re-derives that first. See
[`lifecycle-modules.md`](lifecycle-modules.md).

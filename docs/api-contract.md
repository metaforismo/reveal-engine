# API and adapter contract

The public engine contract is `reveal-engine/api-v1`. Package 0.3 may add backward-compatible fields and exports; breaking behavior requires a new engine API version and a semver-major package change.

## Adapter definition

Create adapters only with `defineGame()`. A `GameDefinition` declares:

- immutable `id`, `adapterVersion`, outcome IDs, and positive prior weights;
- an evidence `modelVersion`, event count, and deterministic derivation function;
- first-entry theoretical RTP, liquidation spread, and payable rounding mode;
- max-win multiple and optional continuation policy.

The adapter fingerprint binds every declarative field above. `modelVersion` is the adapter author's promise that unchanged identity means unchanged evidence behavior. Conformance derives every truth for deterministic seeds and rejects truth-dependent likelihood strength/labels, malformed events, mutable derivations, non-determinism, unfrozen definitions, or non-normalized posteriors.

## Required runtime behavior

- Outcomes: 2–64 unique printable UTF-8 identifiers.
- Evidence: 0–10,000 canonical events indexed from zero.
- Likelihoods and prior values: positive bounded BigInts; prior total below `2^256`.
- IDs/labels/keys and transcript/snapshot payloads are bounded by `ENGINE_LIMITS`.
- Unknown adapter, proof, transcript, or snapshot versions fail closed.

`RevealEngineError` supplies a stable `code`, `path`, and optional string/number/boolean details. Integrations must branch on `code`, never parse message text.

## Compatibility rule

Changing outcome order, priors, evidence generation, pricing, rounding, cap, or continuation rules requires a new `adapterVersion`. A round persists engine API version, adapter ID/version/fingerprint, proof version, transcript schema, and receipt/snapshot versions. An integration must retain the exact adapter implementation needed to replay open liabilities.

Host adoption uses the separate `reveal-engine/compatibility-corpus-v1` wire contract. `parseCompatibilityCorpus()` validates and freezes it; `compareCompatibilityCorpus(game, corpus)` replays current target derivation, projected host posteriors, pricing/settlement observations, and cap cases. Expected migration deltas remain individual findings. Wrong adapter identity fails with `ADAPTER_MISMATCH`; corpus tamper and malformed semantics use distinct typed errors. See [compatibility corpus](compatibility-corpus.md).

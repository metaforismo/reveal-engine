# API and adapter contract

The public engine contract is `reveal-engine/api-v1`; the lifecycle-module
contract is `reveal-engine/module-v1`. Package 0.3 may add backward-compatible
fields and exports; breaking runtime or type behavior requires a new engine API
version and a semver-major package change.

## Definitions

Every lifecycle module exposes exactly one construction path. For the
progressive market that is `defineGame()`. A `GameDefinition` declares:

- immutable `id`, `adapterVersion`, outcome IDs, and positive prior weights;
- an evidence `modelVersion`, event count, and deterministic derivation function;
- first-entry theoretical RTP, liquidation spread, and payable rounding mode;
- max-win multiple and optional continuation policy.

The definition fingerprint binds every declarative field above. `modelVersion` is
the author's promise that unchanged identity means unchanged derivation
behavior. Conformance derives every truth for deterministic seeds and rejects
truth-dependent likelihood strength or labels, malformed events, mutable
derivations, non-determinism, unfrozen definitions, and non-normalised beliefs.

## Required runtime behavior

- Outcomes: 2–64 unique printable UTF-8 identifiers.
- Steps: 0–10,000 canonical events indexed from zero.
- Likelihoods and prior values: positive bounded BigInts; prior total below `2^256`.
- Belief weights may be zero (an eliminated outcome) but the total must stay
  positive.
- IDs, labels, keys, transcripts, and snapshots are bounded by `ENGINE_LIMITS`.
- Unknown module, adapter, proof, transcript, or snapshot versions fail closed.

`RevealEngineError` supplies a stable `code`, `path`, and optional
string/number/boolean details. Integrations must branch on `code`, never parse
message text.

## Compatibility rule

Changing outcome order, priors, step generation, pricing, rounding, cap, or
continuation rules requires a new `adapterVersion`. A round persists engine API
version, module id and version, definition id/version/fingerprint, proof
version, transcript schema, and receipt and snapshot versions. An integration
must retain the exact module and definition implementation needed to replay open
liabilities.

New lifecycle modules must satisfy
[`lifecycle-modules.md`](lifecycle-modules.md), which is the normative contract.

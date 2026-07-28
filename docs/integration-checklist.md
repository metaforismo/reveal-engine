# Integration checklist

- [ ] Commitment is durably published before entries and any seed-dependent information.
- [ ] Seed generation/grinding controls, key custody, rotation, reveal timing, and retention are documented.
- [ ] Adapter ID/version/fingerprint and all wire schema versions are persisted per round.
- [ ] Adapter passes `reveal-conformance` with retained machine-readable output.
- [ ] Host adoption corpus passes `reveal-compatibility`; source revision/hashes, adapter fingerprint, corpus digest, and full non-exact findings are retained.
- [ ] `activationReady` is evaluated separately from `ok`; expected proof/economic deltas and host-managed RIDE are resolved before production routing.
- [ ] Player/tenant authorization and wallet transaction are outside but atomic with the engine receipt.
- [ ] Every open/sell uses the authoritative current posterior and exact expected frame revision.
- [ ] Idempotency key is scoped by player and round in durable storage; payload mismatch is a conflict.
- [ ] Settlement accepts only verified seed/transcript and cannot run before all frames.
- [ ] Snapshot storage is authenticated; restore failures quarantine rather than repair balances silently.
- [ ] Cap basis and liquid value reconcile against wallet history after every action.
- [ ] Ride/continuation has a separately reviewed state machine and economics model.
- [ ] Private package delivery is immutable and reproducible (private registry/release or compiled tarball SHA plus lockfile); no mutable relative checkout dependency.
- [ ] Load, reserve, RNG, game math, jurisdiction, responsible-play, and certification reviews cover the deployed configuration.

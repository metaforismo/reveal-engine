# RGS integration guide

Reveal Engine supplies deterministic state transitions, not a database or wallet. A production RGS must execute idempotency lookup, frame check, authorization, debit/credit, state transition, receipt append, and snapshot/version persistence in one transaction.

Never accept a client-supplied posterior, quote, multiplier, adapter fingerprint, truth, seed, cap basis, or receipt. Client-controlled fields are limited to the selected outcome/stake, opaque idempotency key, and observed frame revision. Settlement comes from the trusted round coordinator and includes the revealed seed plus transcript; `RoundBook` re-verifies both.

Persist engine API version, package/release identity, adapter ID/version/fingerprint, proof/transcript version, frame and ledger revisions, original cap basis, receipt log, and commitment publication timestamp. Retain the adapter implementation while liabilities or verification obligations exist.

Before routing production behavior through the package, capture host vectors with `compatibility-corpus-v1` and compare them in shadow mode. Persist the corpus digest and every non-exact finding. `ok: true` only excludes unexplained deltas/target drift; production activation additionally requires `activationReady: true`, or an independently reviewed and newly versioned migration that deliberately resolves each remaining proof, rounding, and host-managed continuation difference.

The in-memory `RoundBook` demonstrates the contract and reconnect format. It is unsuitable as production persistence because process loss can discard state and its checksum is not an authenticated signature.

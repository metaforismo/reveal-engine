# RGS integration guide

Reveal Engine supplies deterministic state transitions, not a database or wallet. A production RGS must execute idempotency lookup, frame check, authorization, debit/credit, state transition, receipt append, and snapshot/version persistence in one transaction.

Never accept a client-supplied belief state, quote, multiplier, definition fingerprint, truth, seed, cap basis, or receipt. Client-controlled fields are limited to the selected outcome/stake, opaque idempotency key, and observed frame revision. Settlement comes from the trusted round coordinator and includes the revealed seed plus transcript; `RoundBook` re-verifies both.

Persist engine API version, module API version, package/release identity, module ID/version, definition ID/version/fingerprint, proof and transcript versions, step and ledger revisions, original cap basis, receipt log, and commitment publication timestamp. Retain the exact module and definition implementation while liabilities or verification obligations exist.

The in-memory `RoundBook` demonstrates the contract and reconnect format. It is unsuitable as production persistence because process loss can discard state and its checksum is not an authenticated signature.

# RGS integration guide

1. Persist a contract-versioned game definition and round commitment before accepting entries.
2. On each action, atomically check player/round, expected frame revision, terminal status, and idempotency key; debit/credit and append the immutable receipt in the same transaction.
3. Never accept a client-supplied posterior, multiplier, truth, seed, or cap basis.
4. Reveal the seed and transcript only after settlement; let the verifier recompute the commitment.
5. Treat ride/continuation as a separate state machine keyed to its original stake. Recalculate the chain cap on every credit.

`src/integration/rgs-example.ts` is deliberately incomplete infrastructure, not production persistence.

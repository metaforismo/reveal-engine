# API contract

`GameDefinition` is the stable configuration boundary: unique outcome IDs, positive prior weights, deterministic `EvidenceSchedule`, `PricingPolicy`, and `RiskPolicy`. `EvidenceSchedule.derive(seed, context, truth)` must be deterministic and must use `uniform()` for any finite sampling. Contract version and game ID are part of every random draw and commitment.

`quote()` returns a rational multiplier only; `payable()` is the sole payable-credit boundary. Call it for every sell/settlement credit. `RoundBook` demonstrates revision fencing and idempotency but callers must replace its in-memory receipt map with a single durable transaction.

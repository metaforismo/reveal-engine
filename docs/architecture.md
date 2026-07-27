# Architecture

Reveal Engine™ is Axiom Games' reusable technology for progressive-reveal instant games. It is not a game title. The repository is split deliberately:

| Layer             | Responsibility                                         | Cannot contain                                 |
| ----------------- | ------------------------------------------------------ | ---------------------------------------------- |
| `src/core`        | exact posterior, pricing, caps, commitments, contracts | game art, copy, UI, regulation claims          |
| `src/protocol`    | frame revisions, idempotency, ordered transitions      | random outcome logic                           |
| `src/reference`   | BLACK SIGNAL-compatible and synthetic configurations   | title UI/assets                                |
| `src/integration` | RGS boundary example                                   | operator credentials or production persistence |
| `src/cli`         | independent transcript verification                    | private seeds before reveal                    |

All value calculations are `bigint` rationals until an explicit payable rounding boundary. A game definition supplies outcome identifiers and prior weights, a deterministic evidence model, pricing, rounding, risk/cap policy, and an optional continuation policy. It may use any finite outcome count of two or more.

`BLACK SIGNAL — Powered by Reveal Engine™ — An Axiom Games original` is the product-line wording for the first adapter. The ™ symbol is a common-law notice, not a claim of registration.

## State and concurrency

An integration owns balances and durable storage. It must apply each action in one transaction keyed by `(playerId, roundId, idempotencyKey)`, fence it against the expected frame revision, append the receipt before returning it, and enforce `open -> (open|settled)` only. The in-memory `RoundBook` is an executable reference for those rules, not a production ledger.

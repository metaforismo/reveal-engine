# Threat model

## Assets and trust boundaries

The protected assets are a precommitted server seed, unmodified evidence transcript, exact price frame, player balance, original stake/cap chain, and immutable receipt. Clients and transport are untrusted. The operator/RGS is trusted to persist atomically; this library cannot make a database transaction on its own.

## Required controls

| Risk                                | Control                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Outcome/transcript substitution     | versioned, domain-separated SHA-256 commitment binds seed, round, truth and canonical transcript        |
| Modulo bias / cross-game seed reuse | rejection sampling; HMAC labels include contract version, game id, round id and purpose                 |
| Stale frame price                   | optimistic frame revision is mandatory for opens/closes                                                 |
| Replay / double debit               | durable idempotency key and receipt replay                                                              |
| Re-entrant or out-of-order callback | serialized round book, terminal-state guard, monotonic revision                                         |
| Sell-path max-win bypass            | cap is applied to _every_ payable credit, including liquidation and settlement                          |
| Ride-chain accounting error         | cap base is original stake; continuation is explicitly outside within-round proof                       |
| Misleading claims                   | no engine certificate/RTP claim; theoretical equality excludes rounding, caps, spreads and continuation |
| Coupled presentation logic          | engine exposes no tone, compliance or content APIs                                                      |

Seed secrecy remains an operational obligation. A seed is revealed only after terminal settlement. Production adopters need access control, key rotation, append-only audit retention, rate limits, reconciliation, and an independently reviewed RNG/key-management design.

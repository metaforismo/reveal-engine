# BLACK SIGNAL adoption-readiness gap audit

Status: implementation gate for a shadow bridge, not an adoption or certification statement.

## Frozen baselines

- Reveal Engine baseline: `82bddf3747ae2508bc61b8f917e24c221afde68c`.
- BLACK SIGNAL source: branch `v8-signal-identity`, revision `7c63ebae28756df3b0ae96b917db37791cfcc588`.
- The title checkout was inspected read-only. Its deleted `black_signal_dossier.pdf` and untracked `.claude/` are pre-existing user state and must remain unchanged.
- Relevant title-source SHA-256 hashes are stored in the compatibility corpus provenance rather than copying title code or content into this repository.

## Gaps and required closure

| Priority | Finding                                                                                                                                                         | Adoption-safe closure                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | The reference declares one continuation while the title derives two at RTP 95.5% with an 85% floor.                                                             | Add an exact, game-agnostic continuation derivation; set/assert two; guard the full 97.0/96.5/95.5/94.5 ladder.                                                      |
| P0       | Title and engine truth/evidence samplers are deliberately different. The input audit observed 18/64 equal truths and 0/64 equal schedules.                      | Freeze both sides. Classify legacy derivation as an explicit migration delta; never silently substitute one transcript for the other.                                |
| P0       | The title uses a delimiter-based legacy commitment while new engine rounds use canonical `commit-v2`.                                                           | Preserve legacy commitment only as a source observation; require `commit-v2` for engine transcripts and report the proof-version migration explicitly.               |
| P0       | The title floors its fixed-point multiplier and contingent payout before sells/settlement. The engine retains an exact rational claim until a payable boundary. | Compare identical title evidence and report every cent delta. Only a bounded, named early-rounding delta may be expected; any other economic delta fails the corpus. |
| P1       | BLACK SIGNAL does not consume the package and there is no private reproducible dependency mechanism.                                                            | Produce a versioned shadow corpus/API/CLI first. Adoption remains blocked until the title can resolve an immutable compiled private release or hash-pinned tarball.  |
| P1       | RIDE is a host-owned cross-round workflow, not a `RoundBook` transition.                                                                                        | Compare the continuation configuration exactly while classifying lifecycle execution as host-managed and outside within-round replay.                                |
| P1       | No strict host corpus schema prevents changed provenance, adapter identity, unknown fields, malformed BigInts, or relaxed delta policies.                       | Add bounded exact-key parsing, typed errors, adapter isolation, immutable reports, and tamper tests.                                                                 |
| P1       | No deterministic shadow report proves that current engine behavior still matches the frozen target side.                                                        | Store target outputs, recompute them from the adapter, and fail separately on fixture drift and unexpected host/target deltas.                                       |

## Completion rule

This phase is complete only when exact fields remain exact, named migration deltas remain within their declared bounds, current engine replay matches the frozen target side, malformed/tampered corpora fail closed, and all repository gates pass. It does not authorize modifying BLACK SIGNAL, publishing the package, or claiming that the title has migrated.

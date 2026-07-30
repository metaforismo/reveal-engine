# ADR 0011 — Restore binding is external, required, and uniform

- **Status:** accepted
- **Date:** 2026-07-30
- **Context branch:** `main`
- **Relates to:** 0003 (derive, do not trust), 0008 (published round entropy)

## Context

The RE-04 closure bound every live book command and settlement proof to the
published round. Three concrete restore paths still accepted the binding as an
optional third argument:

```ts
RoundBook.restore(definition, snapshot);
CardsBook.restore(definition, snapshot);
SurvivalBook.restore(definition, snapshot);
```

That omission is exploitable. A writer who can replace reconnect state can move
an honest staked or settled snapshot to another real round, recompute the public
`commandFingerprint` values and `snapshotHash`, and supply the proof for that
other round. Every receipt, transcript, exact credit, and cap check then
re-derives honestly under the substituted round. The missing fact is not inside
the snapshot: it is which commitment the operator actually published before
play.

`PermutationBook.restore()` already refused a bound snapshot when its caller
omitted that fact. The lifecycle contract deliberately deferred a generic
restore-evidence slot until a second module needed it. Three now do.

## Decision

The trusted binding stays outside the sealed snapshot and is a required third
argument on both concrete books and `BookModel.restore`:

```ts
book.restore(definition, snapshot, expectedBinding);
```

Each lifecycle shape declares its `roundBinding` type. `null` is the explicit
sentinel for a genuinely unbound snapshot. The four books enforce the same
matrix:

| Snapshot | Third argument              | Result                                       |
| -------- | --------------------------- | -------------------------------------------- |
| bound    | same binding                | restore and continue semantic re-validation  |
| bound    | different binding or `null` | `COMMITMENT_MISMATCH`                        |
| unbound  | `null`                      | restore the pre-publication empty state      |
| unbound  | any binding                 | `COMMITMENT_MISMATCH`                        |
| either   | omitted at runtime          | `COMMITMENT_MISMATCH` at `$.expectedBinding` |

The comparison happens after bounded snapshot/schema/definition parsing and
before settlement-proof or transcript self-verification. TypeScript callers
cannot omit the argument; JavaScript callers that do are refused with the same
typed error.

The binding does **not** travel inside the snapshot as its own authority.
`snapshotHash` is an unkeyed corruption check, not an operator signature.
Anyone able to re-point the snapshot can re-seal it, so a field copied from that
same payload would only let the snapshot authorize itself. The host must read
the expected binding from the independently authenticated published-round
record.

## Consequences

- This is an intentional source-level API break: every restore call must state
  either the trusted published round or the explicit unbound sentinel.
- The registry path can now reconnect real rounds without downcasting to a
  concrete book.
- No snapshot or transcript wire format changes. Frozen fixtures remain
  byte-identical and restore against independently supplied fixture bindings.
- The external binding closes whole-round re-pointing only. It does not
  authenticate other snapshot fields; the existing trusted-storage or signed
  receipt obligations remain.
- `tests/security/restore-binding-regressions.test.ts` contains an honest
  positive control and a re-sealed, re-fingerprinted re-pointing regression for
  each of the four books.

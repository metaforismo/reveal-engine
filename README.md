# Reveal Engine

A TypeScript engine for provably-fair casino games, from **Axiom Games**.

Every round is one committed seed. The truth, the reveal sequence, and the proof
are pure functions of that seed, so anyone holding the transcript and the
revealed seed can re-derive the whole round and check it byte for byte. All
money and probability arithmetic is exact `BigInt` rationals — there is no
floating point anywhere in a path that can pay a player.

The first game built on it is **BLACK SIGNAL**. Reveal Engine is the technology;
BLACK SIGNAL is a title. This repository contains no title art, UI, narrative,
or player-facing copy.

> **Status:** free-play prototype code. No real money, no published package, no
> certification. The engineering bar is real-money grade; the deployment status
> is not. See [what this is not](#what-this-is-not).

## What it is

- **A shared core.** Seeded rejection sampling, commit-reveal sealing, exact
  rational BigInt math, payable floors and win caps, a round command ledger with
  idempotency and frame fencing, and hostile-input-safe wire codecs.
- **Lifecycle modules on top.** A module decides what the hidden truth is, what
  a step reveals, what a player can claim, and how a round settles. Core decides
  nothing about the game.
- **Verifiable by re-derivation, not by assertion.** `reveal-verify` takes a
  transcript and a revealed seed and re-derives the round from scratch. Frozen
  wire fixtures are re-verified on every test run.
- **Zero runtime dependencies.** Node 20+, `node:crypto` only.

## What this is not

This repository is source code, deterministic fixtures, conformance checks,
tests, and synthetic performance measurements. It is **not** a fairness
certificate, an RNG certificate, a mathematical certification, regulatory
approval, a penetration-test attestation, a production-capacity claim, or proof
of any deployed game's RTP.

A deployment needs its own frozen configuration, independently reviewed seed
generation and custody, an operator and wallet integration audit, jurisdictional
analysis, payable simulation, a reserve and risk model, production load
evidence, incident controls, and whatever laboratory or regulatory process
applies. Changing an adapter, a rounding rule, a cap, storage, or a callback can
invalidate everything measured here.

One limitation worth stating up front: deterministic seed-derived truth stops an
operator from choosing the outcome _after_ the seed is committed. It does not
stop an operator from grinding many seeds _before_ publishing one. That is a
seed-custody and publication-ordering problem, and it lives outside this
library. See [`docs/threat-model.md`](docs/threat-model.md).

## Module map

| Module               | What it models                                                                                                     | Status  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ------- |
| **core**             | RNG, commitments, exact math, payments, ledger, limits, wire safety                                                | shipped |
| `progressive-market` | one hidden truth, a Bayesian evidence stream, a single-position book with fair-value sell and re-entry             | shipped |
| `sequential-cards`   | committed deck shuffle; reveals that eliminate outcomes to exactly zero; multiple simultaneous positions           | next    |
| `staged-survival`    | N entities through S stages; a contract chosen per stage before it resolves; per-entity partial claims and banking | next    |
| `permutation`        | structured truth (an ordering of n items) with multi-bet paytable settlement                                       | next    |
| `grid-pattern`       | spatial reveal over a committed grid                                                                               | later   |
| `graph-propagation`  | reveal that spreads along a committed graph                                                                        | later   |
| `campaign`           | value carried across linked rounds                                                                                 | later   |

The contract every module implements is documented in
[`docs/lifecycle-modules.md`](docs/lifecycle-modules.md) and typed in
`src/core/module.ts`.

## Quickstart

```sh
npm install
npm test
npm run verify   # format, lint, typecheck, tests, conformance, build, package, stress, bench
```

Run one round end to end:

```ts
import {
  binaryBeaconReference,
  initialPosterior,
  makeTranscript,
  RoundBook,
} from '@axiom-games/reveal-engine';

const seed = '01'.padStart(64, '0'); // in production: 32 CSPRNG bytes, committed before play
const transcript = makeTranscript(seed, binaryBeaconReference, 'round-42');
// publish transcript.commitment here, before anything a player can act on

const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference));
await book.open({
  idempotencyKey: 'player-action-1',
  expectedFrameRevision: 0,
  outcome: 0,
  stake: 100n,
});
for (const event of transcript.evidence) await book.advanceFrame(event);
await book.settle({
  idempotencyKey: 'settlement-1',
  expectedFrameRevision: book.frame.revision,
  revealedSeed: seed,
  transcript,
});
```

Work against the module contract instead of the convenience API:

```ts
import { requireModule } from '@axiom-games/reveal-engine/modules';

const lifecycle = requireModule('progressive-market');
const transcript = lifecycle.transcript.build(seed, definition, 'round-42');
const result = lifecycle.verify(seed, definition, transcript); // {ok: true, ...} or a typed failure
```

## Verification story

Four independent layers, all reproducible:

1. **Re-derivation.** `reveal-verify <transcript.json> <seed>` re-derives truth,
   evidence, and commitment and compares in constant time. It returns one of six
   typed failure codes — never a parser stack trace.
2. **Frozen wire fixtures.** `commit-v2`, `transcript-v1`, `transcript-v2`,
   `receipt-v1`, and `round-book-v1` are pinned. A known-answer commitment
   vector and both transcript fixtures are re-verified on every run; changing an
   encoding without changing a version breaks the build.
3. **Oracles, not simulations.** Posterior and pricing are cross-checked against
   an independent raw-weight fraction oracle, and the within-round strategy
   theorem is proved by exhaustive enumeration over every two-tick binary path
   for hold, sell, and adaptive switch policies. Monte Carlo is only ever a
   sanity cross-check.
4. **Mechanical conformance.** `reveal-conformance` sweeps every truth for
   deterministic seeds and rejects definitions that are non-deterministic,
   mutable, unfrozen, non-normalised, or that leak the truth through the
   _structure_ of their reveal schedule.

Plus hostile-input tests (malformed seeds, oversized payloads, non-canonical
BigInts, unknown fields, tampered commitments, cross-adapter confusion), race
tests (concurrent duplicate commands, sell versus settle), and snapshot-tamper
tests.

Latest local evidence, including test counts and synthetic throughput, is in
[`docs/evidence-ledger.md`](docs/evidence-ledger.md).

## Documentation

| Start here                                                                      | For                                     |
| ------------------------------------------------------------------------------- | --------------------------------------- |
| [architecture](docs/architecture.md)                                            | layer boundaries                        |
| [lifecycle modules](docs/lifecycle-modules.md)                                  | the module contract                     |
| [API reference](docs/api-reference.md)                                          | package surfaces and lifecycle          |
| [API and adapter contract](docs/api-contract.md)                                | what a definition must guarantee        |
| [math](docs/math.md)                                                            | the theorem and its stated assumptions  |
| [threat model](docs/threat-model.md)                                            | assets, attacker stories, residual risk |
| [certification boundary](docs/certification-boundary.md)                        | what is deliberately not claimed        |
| [versioning](docs/versioning.md)                                                | schema and migration policy             |
| [integration](docs/integration.md) · [checklist](docs/integration-checklist.md) | wiring an RGS                           |
| [ADRs](docs/adr/)                                                               | recorded decisions                      |

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing math, proofs, wire
formats, receipts, or snapshots — those need a versioning decision, a
compatibility fixture, and the full `npm run verify` stack.

Report suspected vulnerabilities privately per [SECURITY.md](SECURITY.md). Do
not include seeds, credentials, or player data in a public issue.

## Licence

`UNLICENSED` — the source is readable here, but no rights to use, copy, modify,
or distribute are granted except under a written agreement with Axiom Games. See
[LICENSE](LICENSE). The package is private and unpublished.

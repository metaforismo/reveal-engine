# Changelog

## 0.4.0 — 2026-07-29

Three lifecycle modules land on the 0.3 platform core, developed independently
and integrated together: `sequential-cards`, `staged-survival` and
`permutation`. None of them required a change to the module contract itself.

### Security hardening follow-up — 2026-07-30

- Caller-owned command payloads are copied once before validation and before
  ledger serialization. Progressive opens and permutation placements never
  re-read stake, outcome, key, frame, bet discriminator, or nested full-order
  arrays. Stored claims expose detached, frozen graphs.
- Progressive, sequential-cards, and staged-survival books now retain the
  independently published round commitment before the first stake, event, or
  choice; bind it into command fingerprints and snapshots; refuse rebinding;
  compare it before transcript self-verification; and can compare it with the
  host's independently retained value during restore.
- **Breaking API:** the third argument to `RoundBook.restore()`,
  `CardsBook.restore()`, `SurvivalBook.restore()`, `PermutationBook.restore()`,
  and `BookModel.restore()` is now required (`null` explicitly means unbound).
  All four books refuse omission or mismatch with `COMMITMENT_MISMATCH` at
  `$.expectedBinding`, replacing `PermutationBook`'s previous `CLAIM_REJECTED`
  contract.
- This is a deliberate snapshot wire break:
  `reveal-engine/round-book-v2`, `reveal-engine/cards-book-v2`, and
  `staged-survival/book-v2` replace their v1 books. The v1 fixtures remain
  negative vectors: they cannot be migrated because they lack a commitment that
  had to exist before play, and migration policy forbids inventing proof.
- AETHER's transcript, ticket, signed receipt, and round snapshot schemas move
  to v2. The seed commitment, shuffle sampler, ticket identity, ticket digest,
  and settlement checks bind the permutation module version, adapter version,
  and full adapter fingerprint. A ticket opened under one economic fingerprint
  is invalid under every other even when the other identifiers collide. The
  original cross-repository v1 fixture remains byte-pinned; a new v2 fixture
  proves the current derivation.
- Progressive restore retains open history and the revealed settlement proof,
  then replays every quote, sell credit, settlement credit, cap, and receipt.
  Coordinated rewrites of historical credits are rejected.
- Settlement digest inputs reject negative, inverted, or inconsistent money
  fields with typed errors. Required client entropy is enforced when a cards
  ticket is admitted.
- Object snapshots are detached and bounded by depth, node count, bytes, and
  array length before allocation or semantic parsing; cycles, sparse arrays,
  accessors, symbols, and exotic prototypes fail closed.
- Synchronous permutation definition construction rejects a conservative
  factorial-work estimate before invoking adapter callbacks.
  `definePermutationGameAsync()` runs the same exhaustive economics and
  behavioural fingerprint walk while yielding between bounded batches.
- Sampler purposes use distinct labels, legacy `commit-v1` stays
  verification-only, and repeated staged-survival settlement returns the
  ledger's stored receipt through the idempotency path.

### `sequential-cards`

#### Added

- **`sequential-cards`, the second shipped lifecycle module**
  (`src/modules/sequential-cards/`, documented in
  [`docs/modules/sequential-cards.md`](docs/modules/sequential-cards.md)). A
  committed deterministic shuffle of a declared finite deck; reveals whose
  posterior is an exact **count of surviving completions**, so an eliminated
  position weighs exactly `0n`; and a multi-position book holding several
  independently funded selections with independent fair-value liquidations,
  self-financed switches and splits that cross no credit boundary, and
  per-selection settlement. Registered in `src/modules/index.ts`, exported at
  `@axiom-games/reveal-engine/modules/sequential-cards`.
- Four reference definitions, all proved by exhaustion at
  `defineCardsGame()` and all run by `reveal-conformance`: `triad-middle-v1`
  (the 3-card middle-pick adapter with a 14-market paytable),
  `triad-stochastic-v1` (the same game credited with the settlement draw),
  `duo-middle-v1` (two simultaneously backed positions), and
  `cascade-middle-v1` (two reveals, where the second has to read the order the
  first published).
- Twenty-one module conformance checks, including `CARDS_POLICY_RETURN_EXTREMAL`
  (argmin and argmax over the **whole** policy space, never a shortlist),
  `CARDS_CAP_NEVER_BINDS`, `CARDS_MIN_STAKE_SUFFICIENT`,
  `CARDS_BELIEF_EXHAUSTIVE`, which cross-checks the posterior against a second
  enumeration that shares no code path with it, `CARDS_ROUNDING_UNBIASED`, which
  counts the credit conversion over the whole draw space rather than recomputing
  its own comparison, and `CARDS_ROUNDING_BOUNDED`, which asserts the two
  premises that carry the exact extremal return across that conversion.
- **`pricing.rounding: 'stochastic'`, the unbiased settlement draw** the
  consuming game declares (`triad/docs/MATH.md` §13.3). A claim of `q + r/d`
  credits `q + 1` with probability exactly `r/d`, drawn from a **committed
  rounding tape** — a one-way derivative of the sealed round seed under a label
  disjoint from the deal and the selectors, so the book draws without ever
  holding the seed, and `settle` refuses a round whose credits came from another
  tape. `capMustNotBind` now measures the cap against the largest **credited**
  amount, which is one credit above the claim ceiling at the minimum stake.
  `'ceiling'` remains declarable and refused. See
  [`docs/adr/0006-the-settlement-draw-and-the-closure-round.md`](docs/adr/0006-the-settlement-draw-and-the-closure-round.md).
- `defineCardsGameAsync()` and `analyseDefinitionAsync()`: the same
  proof-by-exhaustion with the event loop given back between batches of lines.
  One generator drives both paths, so the two cannot prove different economics.
  It is not faster — the ceilings and the refusals are unchanged.
- Frozen wire fixtures `tests/fixtures/cards-transcript-v1.json`,
  `tests/fixtures/cards-book-v1.json` and
  `tests/fixtures/cards-book-stochastic-v1.json`, cut from rounds covering a
  two-row ticket, a reveal, a switch, and a settlement under each rounding
  rule. The deterministic fixtures are byte-identical to the ones written
  before the draw existed.
- An exhaustive oracle test
  (`tests/sequential-cards/oracle-three-card.test.ts`): all 1,716 ordered deals
  times both sealed selectors times all three backed positions, checked against
  an independently coded closed-form model — every posterior, all 26 published
  prices, the expected value of every offered action in every state, the argmin
  and argmax over all `2^38` legal policies, both variance extremes, the whole
  side-market paytable, and the reachable maximum and minimum payouts.
- `composeRoundSeed()`: the operator-seed, client-seed and nonce composition the
  module derives from, written down once with its residual risk stated.

#### Fixed

- **`CardsBook.restore()` credited a liquidation no round could have issued.**
  The `cash` branch replayed none of the guards its `switch`/`split` sibling
  replayed, and nothing constrained a receipt's `frameRevision` beyond
  `<= stepRevision` — so a snapshot could pair a claim grown at a post-reveal
  belief with a price taken at the pre-reveal one. On `triad-middle-v1` with a
  100-credit stake that restored a `liquidBalance` of 4,320 where the honest
  liquidation is 196, with an honest stake, ticket, open receipt and cap basis.
  A receipt's frame must now equal the number of reveals already installed, and
  a restored `cash` clears the same guards `cash()` clears. The conformance
  tamper table gains a re-fenced receipt and two forged liquidations, with a
  legal cash-out alongside as the positive control.
- **The pricing path validated nothing.** `claimProbability` — the module's
  declared `steps.price` — priced whatever step list it was handed, and under
  `sortRemaining: true` a list with an empty final sort silently took the
  exchangeable branch of `cardsBelief`, discarding the published order and the
  cumulative bounds and pricing eliminated outcomes at `1/3`. The record rules
  move to `src/modules/sequential-cards/record.ts` and `cardsBelief` runs them,
  so the check is inside the counting rather than beside it.
- **Documentation that outran the code.** §6.3 claimed `restore()` "defeats
  every _illegal_ rewrite: a state no legal command sequence could have produced
  does not restore, whatever its receipts say", and named the stake as the sole
  residual. Both halves were false while it said so. §6.3, the `restore`
  docstring, `docs/threat-model.md` and ADR 0005 are re-derived, and the
  statement now names two residuals — the stake and the reveal — because those
  are exactly the inputs `restore()` can neither re-derive nor replay.
- `docs/modules/sequential-cards.md` §12.1 was missing two divergences from
  `triad/docs/ENGINE.md`: the `seed.clientEntropy` widening, and the location of
  the settlement draw. Both are tabled, and with `dormancy` removed the spec's
  own §4.1 definition now constructs — checked by a test that transcribes it.

#### Changed

- `docs/lifecycle-modules.md` records two things `sequential-cards` found while
  being written against the contract: a step that moves no money may still need
  to be a ledger command, and a book with no round identity can settle another
  round's proof. Both are closed inside the module; see
  [`docs/adr/0005-sequential-cards-scope-and-the-credit-boundary.md`](docs/adr/0005-sequential-cards-scope-and-the-credit-boundary.md).
- The public-API snapshot test now pins the `sequential-cards` surface, and the
  package export map and smoke test carry `./modules/sequential-cards`.
- **The definition-time analysis ceilings now bound what they claim to.**
  `estimateAnalysisWork` gained the term it never had for `cardsBelief`'s
  `C(size − i, dealt − i)` enumeration — the cost that dominates whenever the
  deck is much wider than the hand — and the new `estimateAnalysisCells` closes
  the cell budget from the declaration, so **both** ceilings are checked before
  the walk rather than one of them from inside it. Re-derived from the worst
  measured rate instead of the best, `CARDS_MAX_ANALYSIS_CELLS` drops
  3,000,000 → 500,000 and `CARDS_MAX_ANALYSIS_OPS` 100,000,000 → 20,000,000.
  The slowest definition they admit walks in about 13 s where the old pair admitted
  25 s walks while publishing "roughly ten seconds", and refused others only
  after 33 s. Lower ceilings refuse some shapes the old ones admitted; that is
  the direction ADR 0005 Decision 5 chose and now measures.
  `scripts/analysis-calibration.ts` is the committed probe table the figures
  come from.
- The reveal-provenance boundary is published rather than left in a docstring:
  a book holds no seed, so `advanceReveal` validates a step as public record and
  cannot establish it came from the sealed deal, and a mid-round `cash` credits
  against a fabricated one before `settle` can refuse the round. Deriving every
  step with `deriveRevealSteps()` is now a named host obligation in
  `docs/integration-checklist.md`, an open row in `docs/threat-model.md`, and
  §6.2 and §12 of the module doc; a test pins the behaviour.

#### Reviewed

- A third independent review found two major and three minor issues, all fixed:
  the analysis ceilings above, the undocumented reveal-provenance boundary, four
  stale figures in `docs/evidence-ledger.md`, a wrong looseness range in §11, and
  three missing divergences from `triad/docs/ENGINE.md` in §12.1. Every one was a
  published claim that outran the code rather than a broken control. See ADR 0005
  Decision 9.
- A second independent review found four major and four minor issues, all fixed:
  commands re-reading the caller's request across the ledger's `await`,
  `restore()` replaying receipt algebra without the round's own rules, a raw
  `TypeError` escaping `restore()`, and an identical-action enumeration with no
  reader. See ADR 0005 Decision 8.
- An independent correctness review (GPT-5.6, read-only) found five issues.
  Three are fixed: settlement flooring the aggregate instead of each selection
  (a one-credit cross-selection carry), a settled snapshot trusting its own
  recorded outcome instead of re-deriving it from the seed it reveals, and the
  ticket claim bound being enforced after an unbounded validation pass. One is
  fixed by narrowing: `liquidationSpread` is now required to be exactly zero,
  because above zero the reported worst-policy return was an arbitrary policy's
  and not an argmin. One is documented rather than fixed: a deterministic,
  unkeyed snapshot cannot be authenticated by re-derivation, so snapshot
  integrity is named as a deployment obligation instead of being implied away.
  See `docs/adr/0005-…` Decision 6.

#### Not included, deliberately

- `rounding: 'stochastic'` — the unbiased settlement draw a consuming game
  declares — is **declarable and refused** at definition time with
  `INVALID_ROUNDING_POLICY`. `BookModel.create(definition)` cannot carry a round
  seed and a per-credit-event draw is not derivable from a transcript's inputs,
  so implementing it needs a core change larger than this module. ADR 0005 §4
  records exactly what it would take. Only `rounding: 'floor'` is implemented.

### `staged-survival`

#### Added

- `staged-survival` (`src/modules/staged-survival/`, documented in
  `docs/modules/staged-survival.md`): N entities through S stages, a stage
  contract chosen from an adapter-defined menu **before** the stage resolves, and
  per-entity contingent claims banked in subsets between stages. Registered in
  `src/modules/index.ts` and exported at `./modules/staged-survival`, so it runs
  in `reveal-conformance` and in the package smoke test without either being
  edited for it.
- **Correlation is a declared property.** A `LaneProfile` is a shared per-lane
  shock `q` plus an independent per-entity clear `c`: the marginal
  `p = (1 - q)c` is the same for every geometry while the joint law is a
  convolution of per-lane binomials mixed with a point mass at zero.
  `q = 0` is exactly zero, so a contract can declare exact independence.
- **A counterfactually complete tape.** The seed expands into a draw for every
  stage, every contract on the menu, every lane slot and every entity —
  `stages x contracts x entities x 2` — before the round opens. A decision
  selects which committed draws are read, never which draws exist, and the
  unchosen routes stay verifiable after the reveal.
- **Player entropy in every draw.** A round is identified by the pair
  `(roundId, clientEntropy)`; the seed pre-commitment binds only the operator
  half, because the entropy does not exist when it is published. See
  `docs/adr/0008-round-entropy-without-a-core-change.md` for why this rides in
  the contract's `roundId: string` rather than through a widened core signature,
  and what that costs.
- **Two mechanical refusals at define time.**
  `marginalSurvival * multiplier === pricing.continuationReturn === 1` for every
  contract, so every route through a round returns the same and the entry margin
  is the whole edge; and, when `risk.capMustBeUnreachable` is declared, the exact
  maximum round return `entryReturn * max(mu)^stages` must sit strictly below
  `risk.maxWinMultiple`.
- Wire formats `staged-survival/transcript-v1` and `staged-survival/book-v1`,
  with frozen fixtures in `tests/fixtures/` compared field for field.
- A mandatory oracle test (`tests/staged-survival-oracle.test.ts`): a
  three-entity, two-stage instance enumerated **exhaustively** against an
  independently coded model — every elementary draw pattern of every reachable
  field, the survivor distribution term for term, the expected value of every
  contract path under every banking policy, and the round cap held across the
  whole chain and shown to bind exactly where the arithmetic says it must.
- Two reference definitions: `fiveRunnerReference` (five runners, three stages,
  `wide`/`split`/`narrow`) and `oracleTrialReference`.

#### Fixed

- **`restore()` runs the live path's admission test on the _pending_ decision.**
  Every choice with a resolved step was re-validated through
  `assertStepGeometry()` -> `contractFor()`. The trailing one — logged by
  `choose()`, not yet resolved — had no step to be checked against, so it arrived
  through nothing but the structural wire parse and its contract id was never
  matched against the menu it faces. A re-sealed, fingerprint-consistent snapshot
  whose pending decision named an unknown contract, or one the field is too small
  to be offered, restored with its bank credit already standing and no legal move
  left: `resolve()` fails on `contractFor`, `settle()` refuses an unresolved
  decision, and `bank()` refuses a pending one. No value is created and the cap is
  untouched; the loss is availability on a round holding money — the same shape as
  `enter -> bank -> enter` and the lane-geometry drift, one field over, and the
  third time this module has fixed it. `restore()` now calls `contractFor()` on
  the field the decision faces and holds its banked subset to the entities that
  were running. `tests/security/staged-survival-hostile-input.test.ts` carries the
  metamorphic half: what `choose()` refuses, `restore()` refuses.
- **`laneSizes()` bounds the field size, not only its sign.** The width is the
  loop's decrement and was bounded; `liveCount` is the _length of the array the
  loop builds_ and was checked only for being a non-negative safe integer.
  Measured on the exported helper: `3e7` allocated thirty million elements and
  returned, `1e9` spent five seconds and died with a bare `RangeError` — an
  unbounded allocation and an untyped throw out of a public export.
  `SURVIVAL_LIMITS.maxEntities` is 32, so no legitimate call is affected;
  `lanePartition()`, `expectedSurvivors()` and `liveAfter()`'s entity count take
  the same bound for the same reason.
- **`liveAfter()`, `belief()` and `price()` no longer price a corrupt step
  prefix.** The guard read `steps[steps.length - 1]` and returned early only on
  `undefined`, which conflated "no steps yet" with "a hole where the last step
  should be". Two failures fell out: a nullish element dereferenced null for a
  bare `TypeError`, and — worse in kind — `price(definition, [undefined], claim)`
  took the empty branch and returned a live entity's marginal for a round whose
  prefix is corrupt. A silently wrong price is a worse outcome than a loud
  refusal. The length now decides the branch, every element of the prefix is
  checked, and a hole is a malformed prefix: `DERIVATION_FAILED`.
- **Nothing on the exported surface throws an untyped error.** The claim was
  unqualified and a systematic sweep found 47 places where it was false. The
  probability helpers validated `contract.laneWidth` and then dereferenced
  `profile.laneFailure.numerator`, so `{laneWidth: 2}` came back as a `TypeError`
  from a pricing call; `resolveStage()` bounded what its draw sources returned but
  never checked they were callable, and let whatever a throwing callback raised
  propagate; `distributionTotal`, `expectedSurvivorsFromDistribution`,
  `threshold`, `stepsEqual`, `choicesEqual`, `transcriptToWire`,
  `serializeTranscript` and `SurvivalBook.bankableAmount` read `.length` or a
  field off `null`. None was reachable from an untrusted path — `verify()`,
  `deserializeTranscript()` and `restore()` were and are total — but the claim was
  the thing under test, so the helpers moved rather than the claim. A shared
  `assertLaneProfile()` holds a contract to the same ranges a declared one is held
  to; `survivorDistribution()` additionally requires the contract to be one its
  definition declares, since a foreign one's denominators need not divide
  `drawModulus` and its law is one no round of that game could realise;
  `resolveStage()` requires callable sources and wraps what they throw in
  `DERIVATION_FAILED`, passing a typed failure from inside a source through
  unchanged. Every new validator iterates **by index**, because `forEach`, `map`,
  `every` and `reduce` all skip holes and a sparse array is exactly the shape that
  would walk past them. The sweep is kept as a test over every exported entry
  point, so a new export that forgets its guards fails it.
  `docs/adr/0009-the-exported-surface-is-held-to-the-command-surface-standard.md`
  records the decision and the two behaviour changes a consumer could notice.
- **`npm run fixtures:update` is idempotent against the repo's own format gate.**
  It wrote raw `JSON.stringify(…, 2)`, which disagrees with prettier over short
  arrays, so regenerating an unchanged fixture left four files dirty with a
  pure-whitespace diff and `npm run verify` then failed at `format:check` — while
  `docs/modules/staged-survival.md` §7.4 points readers at that command as the
  deliberate regeneration path. The script now formats its output with prettier
  and the repo's own configuration, and regenerating an unchanged fixture leaves
  the tree clean.
- **`bank()` now carries the same full-funding guard as `choose()`.**
  `enter(0) -> bank([0])` was accepted by the live path and credited real money,
  after which `enter(1..4)` was still legal — and `restore()` refuses an `enter`
  receipt that follows a `bank` one, so the round became permanently
  unreconnectable at that point and at every later point of its life. No value
  leaked (the cap basis only grows, so an early bank is measured against a
  strictly smaller ceiling); availability did. An entry after a bank is now
  impossible as a consequence rather than as a second guard: by the time a bank
  can run, every entity id is taken.
- **`restore()` no longer accepts a withdrawal set the live path cannot
  produce.** The withdrawn entities were reconciled as a _set union_ of every
  decision's `banked` list plus `pendingBanked`, so an entity present in both
  collapsed into one element and passed the count check. The two sources are now
  read as a disjoint union, and a snapshot carrying both an unresolved decision
  and an uncommitted banked subset is refused outright — `choose()` folds the
  subset into its own decision and clears it, and `bank()` is closed while a
  decision is pending. Restored, such a state re-folded the stale entity into the
  next decision and the round could never produce a valid transcript or be
  settled. `restore()` also now requires a fully funded entry list whenever the
  snapshot carries a bank record, not only a logged decision.
- **`defineSurvivalGame()` refuses a definition it could not price.** Entity
  count, stage count, draw modulus, menu size and tape size were each bounded,
  but the quantities derived from them grow as powers — `den(c)^entities` in the
  field survivor law, `mu^stages` in the maximum round return. A declaration
  could satisfy every field-level bound, satisfy `p * mu == 1` exactly, and still
  make `survivorDistribution()` or `maxRoundReturn()` raise `INVALID_RATIONAL`
  from inside the rational primitives at the first derivation — an adapter defect
  surfacing as an engine arithmetic failure, and one that aborts a conformance
  run part way through. Both derived widths are now bounded at define time with
  an `INVALID_ADAPTER` refusal; the bounds are sufficient rather than tight and
  `docs/modules/staged-survival.md` §4.8 states them and says so. A test pins the
  slack from the other side: a 32-entity field in one lane at 60-bit denominators
  must still define and still derive a law summing to exactly `1`.
- **`enter()` bounds the stake's width, not only its sign.** A claim value is
  `stake * entryReturn * prod(mu)`, and the stake was the one input to it that
  was never bounded. A stake wide enough to overflow that product passed
  `fundStake()` — which had already moved the cap basis and the entry list — and
  then raised `INVALID_RATIONAL` while the claim was being constructed, leaving
  an inflated basis, an entry with no claim and no receipt, in a book `restore()`
  could not even parse. `SURVIVAL_LIMITS.maxStakeBits` is now 64, reserved inside
  the define-time pricing bound, so a stake that clears `enter()` cannot overflow
  anywhere in the round. `restore()` holds a restored entry stake to the same
  width, because the snapshot codec's own bound is the far wider engine limit.
- **`resolve()` now runs the same step admission test as `restore()`, from the
  same function.** The live path checked the resolved set and skipped the lane
  geometry that `restore()` re-derives, so a step reporting a partition the
  chosen contract does not produce — lanes re-cut, lanes emptied, one entity in
  two lanes, or every lane flagged collapsed while reporting survivors — was
  accepted live and refused by every later `restore()`. The book could take a
  `bank()` credit in that state and then never reconnect, which is exactly the
  availability defect recorded two entries above for `enter -> bank -> enter`,
  reintroduced one field over. Both paths now call one `assertStepGeometry()`, so
  the set equality, the lane partition and the collapsed-lane rule are checked
  identically going in and coming back; the duplication that let them drift is
  gone. `tests/security/staged-survival-hostile-input.test.ts` asserts each shape
  is refused and carries the metamorphic law — nothing `resolve()` accepts may be
  something `restore()` refuses — which is the test whose absence let this
  through.
- **The tape now moves with the definition fingerprint, not only with its id.**
  `roundIdentityOf()` put `definition.id` in `definitionId`, which core maps onto
  the sampler `domain`, so two definitions sharing an id and a version but
  declaring different `laneFailure`/`entitySurvival` produced byte-identical
  tapes under one seed. Not exploitable — the seed pre-commitment binds the
  fingerprint independently, so a substituted definition fails
  `COMMITMENT_MISMATCH` — but the grid was blind to the fields that decide what a
  draw means, and SWARM §6.4 requires the opposite. The domain is now
  `survivalFingerprint(definition)`: used whole rather than appended to the id,
  because the id is already inside the fingerprint's preimage and because an
  `id#fingerprint` composite would break the 128-byte identifier bound at a
  maximal id. `TAPE_NOT_DETERMINISTIC` now checks the binding structurally on
  every adapter, and the module suite checks it behaviourally on twins.
  **This changes every derived tape**, so the frozen fixtures were regenerated
  deliberately; the wire _format_ is unchanged and stays `-v1`, which is
  defensible only because this module has never shipped — 0.4.0 is its first
  release. The frozen round was also re-seeded to `0a…` so it rides all three
  reference contracts and both lane states instead of one contract three times.
- **`resolve()` fails closed with a typed error on a malformed step.** It is the
  one entry point that takes a step as a raw object rather than through
  `parseWireStepList`, and four shapes threw a bare `TypeError` out of a
  money-bearing command instead of a `RevealEngineError`: `survivors`, `failed`
  or `banked` undefined, and `failed` as a number. A step assembled with its
  `lanes` on a prototype was also accepted, where the transcript wire boundary
  has always refused an inherited key. `assertStepShape()` now runs before any
  field is read, checks every field as an **own** property, and reports
  `TRANSCRIPT_MISMATCH` with a path. `restore()` deliberately does not call it —
  its steps come through the wire parser, which is stricter — and the comment
  says so rather than leaving the asymmetry to be rediscovered.
- **`resolveStage()` validates its own arguments.** It is a public export and it
  is the function that produces the step object `book.resolve()` credits from,
  yet it accepted duplicate entities, entities outside the definition,
  non-integer entities, a 500-element field on a 3-entity game, and draws outside
  `[0, drawModulus)` — where a negative draw collapses every lane and a draw at
  the modulus collapses none, whatever probability was declared. The live field
  must now be ascending, distinct and inside the definition (its order is part of
  the geometry, since `lanePartition()` cuts consecutive slices), and both draw
  sources are held to the modulus. No internal caller could reach any of it, so
  this is hardening rather than a live-bug fix, and it makes the function consistent
  with `laneSizes()` and `laneSurvivorDistribution()`, which already argued that
  an exported helper checks its own bounds.
- **`MAX_ROUND_ID_BYTES` and `ROUND_REF_SEPARATOR` are exported.** ADR 0008 names
  "a host can check the budget rather than discover it" as the one mitigation for
  the ergonomic cost it accepts, and the constant was not in the subpath, so the
  mitigation existed only on paper. Both are now exported and pinned by the
  public-API list and by a boundary test.
- **`laneSurvivorDistribution()` bounds its lane size by the contract width.** It
  is an exported helper reachable with an arbitrary size, and `c^j` under it is a
  power, so a validated contract with a wide denominator overflowed there rather
  than refusing an out-of-range argument. `lanePartition()` never produces a
  wider lane, so no internal caller changes.
- The stress digest gate validates its own baseline with `assertStressArtifact`
  and fails when it cannot — a gate that quietly stops gating when its input is
  malformed is not a gate — and compares the **union** of both key sets, so a
  module the baseline does not anchor is drift too rather than silently ungated.
  `compareModuleDigests()` is extracted and unit-tested in both directions.

#### Changed

- `docs/lifecycle-modules.md`, `README.md` and `docs/api-reference.md` record
  that two modules ship. **No core file was modified.**
- **Stress and benchmark artifacts carry one replay anchor per lifecycle
  module.** `correctnessDigest` became `moduleDigests`, keyed by module id, and
  both schemas moved to `reveal-engine/stress-v3` and
  `reveal-engine/benchmark-v3` (baselines renamed to `artifacts/stress-v3.json`
  and `artifacts/benchmark-v3.json`). A single digest over a whole run moves
  whenever a module is _added_ to the workload, which makes a new workload
  indistinguishable from drift in an existing one. `progressive-market`'s 0.2 and
  0.3 values are carried forward byte-identical under its own key. The stress
  run now compares every anchor the baseline carries and fails on a mismatch
  **or** on a module the baseline anchors and the run no longer produces.
- Both scripts run `staged-survival` alongside `progressive-market`, so the new
  module ships with bounded-load and throughput evidence gated by the same
  `npm run verify` and CI steps as the first one. `docs/evidence-ledger.md` is
  rewritten for this branch and now carries a per-module section.
- `docs/modules/staged-survival.md` §10 no longer claims BRANCHFALL's
  player-chosen lane balance is expressible as one contract per balance. One
  balance at one field size is; the menu as a whole is not, because the lane
  count is a function of the field rather than of the contract, a later lane can
  never be larger than an earlier one, and there is no `maxEntities` to keep a
  contract off larger fields. The gap is now stated in both the module doc and
  `TODO.md`.
- **`docs/modules/staged-survival.md` §10 no longer makes a blanket coverage
  claim.** It said "everything else in SWARM's §6 conformance list is covered
  here", which was checkably false for several of the eighteen items — there is
  no action chain for §6.11, the grid did not move with the fingerprint for §6.4,
  and `bank([])` is refused where §6.14 wants every `k` in `[0, units]`. §10 is
  the section a consuming team is entitled to trust as a gap analysis, so it now
  carries the list item by item with a verdict of provided, analogue, partial,
  inherited, N/A or not provided, and a reason for each. The missing action chain
  is named in "Not provided" rather than left to inference.
- **§10 gained a cap-basis row and §10.2.** BRANCHFALL's main route ticket
  declares `risk.capBasis: 'per-ticket'` in bold, and this module refuses
  anything but `round-external-stake`. The divergence was mentioned only inside
  the side-bets bullet, framed as a per-line concern, so a reader checking
  BRANCHFALL's main-ticket declaration against the "Provided" table found
  nothing. It is now a row and a section: no value is at risk while
  `capMustBeUnreachable: true`, because `assertCapIsUnreachable` forces the exact
  maximum round return strictly below `maxWinMultiple` and total credit cannot
  exceed `basis * maxRoundReturn`; under a `false` declaration a shared round
  ceiling genuinely differs from a per-ticket accumulator, since an early bank
  consumes headroom the latter would keep separate.
- **§5 and §9 now state the credit-before-proof ordering.** §7.3 already said
  `restore()` "holds no seed, so it cannot verify a step against the tape", but
  §5 presented `bank()` without the equivalent caveat and the residual-risk list
  omitted it. `bank()` credits against a step checked for shape and not for
  truth; `settle()` is the only call that verifies and it runs afterwards. Closing
  the lane-geometry gap narrows this but cannot close it — the survivor bits
  inside a lane that held are exactly the part that needs the seed.

### `permutation`

#### Added

- **The AETHER ORDER engine contract** (`src/modules/permutation/aether/`,
  package subpath `./modules/permutation/aether`): a full implementation of
  `aether-order/docs/ENGINE.md`, which declares itself normative and demands
  byte-identical commitments, ticket digests, receipt digests and signatures.
  Covers §2 identity and schemas, §4 adapter-supplied `BetFamily` catalogues
  with a behavioural catalogue digest and adapter fingerprint, §5–§7 seed
  commitment, client-seed and nonce-bearing sampler, chained transcripts,
  tickets with derived idempotency keys, exact settlement, Ed25519 receipts and
  round snapshots, §8 all twelve conformance checks, and §9's error vocabulary.
  The eleven AETHER ORDER families ship as a **reference adapter**, so an
  integrator can supply their own catalogue and it will be priced, digested and
  fingerprinted. `docs/adr/0010` argues the decision.

  Proved, not asserted: `tests/aether-frozen-fixtures.test.ts` re-derives all
  **eight** rounds frozen in the game repository and requires every digest and
  every deterministic Ed25519 signature to match byte for byte. ENGINE.md §10
  says "if a single commitment digest differs, the port is wrong"; none differs.

  This closes a review finding that the module **could not drive AETHER ORDER
  although it shipped AETHER ORDER references** — six of eleven families, the
  client seed, the nonce, the seed commitment, round chaining and three wire
  schemas were all absent, and the module owned its catalogue so an adapter
  could not add them.

- `PERMUTATION_ERROR_CODES` in `src/api/errors.ts`, the eight wire codes
  ENGINE.md §9 requires, as a separate group so a reader can still see which
  public contract introduced each code. `CORE_ERROR_CODES` and
  `MODULE_ERROR_CODES` are unchanged.
- `DERIVATION_OFF_SCHEDULE` conformance check plus
  `tests/shuffle-uniformity.test.ts`: the shipped derivation is now pinned to
  the draw schedule it documents. `SHUFFLE_NOT_BIJECTIVE` proves a property of
  the algorithm and never calls the sampler, so a naive-shuffle edit to
  `core/random.ts` previously passed conformance green and survived
  `npm run fixtures:update` at 565/566. It now fails all three references and
  nine tests, and neither is a fixture.
- `tests/sampler-unbiased.test.ts`: the evidence `docs/modules/permutation.md`
  §2 Lemma B used to cite and that did not exist. Checks the acceptance boundary
  over every modulus in `1..512`, **executes** the rejection branch at
  `M = 2^255 + 1` where half of all draws reject — for the moduli in real use it
  fires with probability `~2^-254` and no test had ever taken it — and
  chi-squares the residues, each with a decoy the same bound must reject.
- `representativeInstance`, so `definePermutationGame` no longer materialises
  all `n!` `full` orders to read element zero: 17.3 ms per call at `n = 8`
  becomes 0.042 ms.

#### Fixed

- **`PermutationBook.restore()` claimed "a rewritten ticket cannot survive its
  own log". It can.** `commandFingerprint` is an unkeyed SHA-256 over public
  fields and is an export, so a forger rewrites the log alongside the ticket: a
  5,000-chip line nobody placed restores a balance of 576,120 against an honest
  120, while the caller passes the correct published round. The claim is gone,
  the residual is widened from "which round" to the entire ticket and its
  accounting across `docs/modules/permutation.md` §9.2, `docs/threat-model.md`
  and `docs/integration-checklist.md`, and both forgeries are executed in
  `tests/security/snapshot-mutation.test.ts`.
- `docs/lifecycle-modules.md` now carries the caveat the module doc does: "no
  core change" was bought by narrowing two of the contract's five book slots, so
  a host driving the registry polymorphically must downcast to open or reconnect
  a real permutation round.
- `docs/modules/permutation.md` §11 no longer opens "this module is compatible
  with the part of it that concerns the draw", which was true of the semantics
  and false of the bytes.

- **The `permutation` lifecycle module** (`src/modules/permutation/`,
  documented in `docs/modules/permutation.md`): a committed permutation of
  `n` labeled items (`3 <= n <= 8`) drawn by core's seeded Fisher-Yates, settled
  as a multi-bet ticket against a published paytable. Five bet families —
  `full`, `slot`, `first`, `last`, `stack` — priced by **exact factorial
  enumeration** over the orders still consistent with the revealed prefix. No
  float, no simulation, and no core file changed: the second module landed
  inside the `reveal-engine/module-v1` contract exactly as it stands, and §10 of
  the module doc records the two places it came closest not to.
- Reference adapters: `aether-order-classic` (`n = 5`) and `aether-order-seven`
  (`n = 7`), reproducing the AETHER ORDER paytable from
  `aether-order/docs/MATH.md` at `rho = 24/25` exactly, plus `triad` (`n = 3`)
  at the supported floor. All three are declared as
  `conformance.references`, so they run in `reveal-conformance` and in CI.
- Eleven conformance checks for the module, six of them exhaustive rather than
  sampled: `SHUFFLE_NOT_BIJECTIVE` walks every one of the `n!` Fisher-Yates draw
  vectors, `STEP_STRUCTURE_LEAKS_TRUTH` sweeps every `n!` truth, and
  `CLAIM_IDENTITY_NOT_BEHAVIOURAL` proves the `O(n)` claim signature groups
  instances exactly as the `O(n!)` win set does.
- An independent oracle suite (`tests/permutation-oracle.test.ts`): closed-form
  factorial probabilities for every instance at `n = 5` and `n = 7`, exhaustive
  win-counting over the whole order space, an exhaustive conditional sweep over
  all 206 reachable prefixes at `n = 5`, and realised RTP measured by brute force
  over every outcome. It shares no code with the module — different permutation
  generator, its own factorials, resolve predicates written from the rules in
  prose.
- Frozen wire fixtures for the two new formats,
  `permutation-transcript-v1` and `permutation-book-v2`
  (`tests/fixtures/`, regenerated with `npm run fixtures:update`), covering a
  settled three-line ticket with a deliberate loser on a bound round.
  `permutation-book-v1.json` is kept as the frozen **negative** fixture: it is
  the retired, unbindable format, and the suite asserts it is refused.
- Package export `./modules/permutation`, wired into `scripts/package-smoke.mjs`
  and the public-API snapshot. The module is deliberately **not** re-exported
  from the package root: the root's progressive-market symbols exist only as
  deprecated 0.2 compatibility, and a module landing today has no such debt.
- **A `PermutationBook` is bound to a published round before it may take a bet.**
  The constructor takes `(definition, binding)` — or `bind()` supplies one while
  the book still holds no claim — and `place()` refuses an unbound book while
  `settle()` refuses any transcript naming a different `roundId` or opening a
  different `commitment`, compared in constant time and checked before the proof
  is verified. Without it, "the transcript verifies" was the only question asked
  at settlement, and it is the wrong one: every transcript this module builds
  verifies, so an operator holding a placed ticket could derive rounds until one
  settled it at zero and settle against that, with every artefact still checking
  out. `docs/modules/permutation.md` §9.1 carries the argument and §11.1 states
  plainly what the module still cannot enforce — it cannot see whether or when
  the commitment it was handed was actually published, which stays a host
  ordering control.
- A `place` command's fingerprint now covers the round binding as well as the bet
  and the stake, so a **partial** rewrite of a snapshot — the binding moved and
  the receipts left alone — contradicts its own log and is refused. That is the
  full extent of what the fingerprint buys, and it is not enough on its own:
  `commandFingerprint` is an unkeyed SHA-256 over public fields and the
  transcript builders are public exports, so anyone who can rewrite the snapshot
  can recompute every fingerprint and the checksum and produce a **consistent**
  snapshot of a different round. That artefact is indistinguishable from an
  honest one by any in-process check, at any stake, staked or settled.
- **`PermutationBook.restore()` therefore requires the round the caller published
  whenever the snapshot carries a binding.** A restored book's round comes from
  the caller and never from the snapshot; the snapshot's own binding is
  reconciled against it. Omitting it on a bound snapshot fails with
  `CLAIM_REJECTED` at `$.expected`, and naming a different round fails with
  `COMMITMENT_MISMATCH` at `$.binding`. That value must be read from the
  published-round record rather than from the snapshot store, which is now a line
  in `docs/integration-checklist.md`.
- The lifecycle contract's two-argument `book.restore(definition, snapshot)`
  consequently restores **only unbound snapshots** and refuses every bound one.
  This is the same deliberate narrowness as the contract's `create`, which
  returns an unbound book: the signature has no round to hand over, so the states
  it can reach are the states in which no money is at risk. A host reconnecting a
  real ticket calls `PermutationBook.restore(definition, snapshot, round)` — the
  class is this shape's `book` type, so resolving the module by id already
  reaches it. The unsafe path is gone rather than documented.
- A terminal `permutation-book-v2` snapshot carries the round id and the
  **revealed seed**, so `restore()` re-derives the settled order and commitment
  from the proof rather than reconciling them against the credit. Reconciling
  the credit alone is not sufficient — two different orders can pay a ticket the
  same amount, trivially any two under which every line loses — so a snapshot
  naming the wrong order would have restored cleanly under a recomputed
  checksum. Publishing the seed in a _settled_ snapshot discloses nothing: the
  reveal is what closes the round.

#### Changed

- The module registry now lists two lifecycle modules. `listModules()` returns
  `['progressive-market', 'permutation']`, and the snapshot tests that pin that
  surface were extended rather than relaxed.
- **Book snapshot schema `reveal-engine/permutation-book-v1` is retired with no
  migration**, replaced by `-v2` which carries the round binding and the settle
  command's idempotency key. There is no honest migration: the field `v1` lacks
  is the published commitment, and nothing in a `v1` snapshot says what it was —
  reconstructing one from the settlement the snapshot already carries would
  manufacture the evidence the binding exists to supply. `v1` is refused with
  `UNSUPPORTED_VERSION` and a message that says why. The format never shipped
  outside this branch.
- `restore()` now pins the two receipt fields that move no balance and were
  therefore free: a `place` receipt's `capped` flag (always `false` — a debit
  cannot meet a credit ceiling) and the `settle` receipt's idempotency key,
  which the settlement record now carries so that every receipt's key is named
  by the state that receipt produced. Both are audit-integrity rather than money
  bugs, which is exactly why nothing else would have caught them: a restored
  receipt log that disagrees with the operator's command log reconciles
  perfectly.

#### Fixed

- **A false security claim about snapshot restore, in four places.** The module
  doc (§9.1, §12), `PermutationBook.restore`'s own comment and this changelog all
  said that binding the round into the `place` command fingerprint stopped a
  staked or settled snapshot being re-pointed at another round. It does not: the
  fingerprint is an unkeyed hash over public fields, so the rewrite is consistent,
  cheap and undetectable — and the module's own test file said so in a comment,
  so the repository contradicted itself on a fairness surface. All four now state
  what is true, `restore()` requires the published round for any bound snapshot,
  and the two facts are pinned by tests that build the working rewrite rather than
  by prose. See Added above.
- `stakedSnapshotFor` is no longer exported from `./modules/permutation`. It is
  conformance scaffolding — a staked snapshot synthesised without the book's
  async command API — and had no business on a surface the package promises to
  keep stable. It stays exported from `checks.ts` for the tests and checks that
  need it, exactly as `progressive-market` keeps its own.
- `npm run fixtures:update` leaves a clean tree. It wrote `JSON.stringify(…, 2)`
  output, which disagrees with prettier about arrays, so the documented
  regeneration command produced whitespace-only diffs in all three regenerated
  fixtures and `npm run verify` then failed at its first step. The script now
  formats what it writes with the repository's own prettier config, and
  regenerating an unchanged tree is byte-identical.
- `docs/modules/permutation.md` §2 and `permutationRound()` no longer restate
  core's "two games and two rounds never share a draw" without its caveat.
  `samplerScopeOf` maps `domain = definitionId` and drops `moduleId`, so
  cross-module separation holds by definition-id uniqueness across the registry
  rather than by construction. Nothing is exploitable — the commitment body binds
  the module id — but the caveat belongs with the claim.
- `enumerateOrders(n)` is bounded to the module's supported draw sizes, like
  every other counting entry point. It was checked only for `n >= 0`, so a host
  forwarding a caller-supplied size had an unbounded allocation: `n = 13` is
  6.2e9 orders and `n = 20` never returns.
- `enumerateInstances()` and `betParameters()` raise `CLAIM_REJECTED` on an
  unknown bet code instead of falling past every `switch` case and returning
  `undefined` three frames from where it breaks.
- `assertBet()` enforces an exact key set per bet code. `{code: 'first', item: 0,
position: 9}` was silently accepted as `first{0}`, so a host typo became a
  different, cheaper claim — inert on the money path, because `betParameters()`
  normalises what reaches the fingerprint and the wire, but a claim the player
  did not ask for is not something to accept quietly.
- The module's shadowed `INVALID_CHOICE` guard in `transcript.commitmentBody` is
  gone. `defineLifecycleModule()` raises it first for `choiceTiming: 'none'`, so
  the module's copy was unreachable and the test that read as proving it was
  exercising core. What makes the omission safe is stated and tested instead:
  `permutationCommitmentBody` has no choice parameter at all.

## 0.3.0 — 2026-07-29

Platform restructuring: a game-agnostic core plus lifecycle modules as siblings.

### Added

- `reveal-engine/module-v1`, the lifecycle-module contract (`src/core/module.ts`,
  documented in `docs/lifecycle-modules.md`): definition model, truth model, step
  and choice semantics, transcript schema and versioning, book and claim
  semantics, verifier phase order, and conformance hooks.
- Core primitives every module builds on: `weights.ts` (exact non-negative
  belief weights where zero is a legal, exactly-zero elimination),
  `combinatorics.ts` (`factorial`, `fallingFactorial`, `countingProbability` —
  exact pricing for a truth space too large to flatten into a weight vector),
  `random.ts` (`uniformPermutation`, `RandomTape`), `commitment.ts`
  (`sealCommitment`, `sealSeedCommitment`), `ledger.ts` (`CommandLedger` —
  serialization, idempotency, receipts, cap chain), `snapshot.ts`,
  `verification.ts`, `versions.ts`.
- Two-phase commitment for rounds whose steps consume player decisions:
  `sealSeedCommitment()` publishes the seed before the first choice exists, and
  `TranscriptModel.commitmentBody` binds the logged choice log so one published
  commitment cannot be re-settled under different decisions. Required by
  `defineLifecycleModule()` for any module whose `choiceTiming` is not `none`.
  See `docs/adr/0002-cap-basis-and-choice-timed-commitment.md`.
- `StepModel.beliefSpace` and `StepModel.price()`: a module whose truth space is
  combinatorial declares that its weight vector is a marginal view rather than
  its pricing space, and prices claims by exact counting instead.
- `TranscriptModel.choicesOf`, required whenever `choiceTiming` is not `none`.
  It is how `defineLifecycleModule()` reaches the decoded choice log on the
  `verify()` path — the one entry point that reads a choice list off the wire
  and the one the guard previously missed. See
  `docs/adr/0003-snapshot-derivation-and-the-choice-guard.md`.
- `SNAPSHOT_NOT_REVALIDATED` conformance check for `progressive-market`, so the
  CI conformance step exercises restore-tampering for the registered module: a
  staked mid-round snapshot restored and then re-sealed with each of seven
  tampered fields, including both money-bearing position fields.
- Frozen wire fixtures for `receipt-v1` and `round-book-v1`
  (`tests/fixtures/`, regenerated with `npm run fixtures:update`), and a
  comparison of the seeded stress workload's `correctnessDigest` against its
  committed baseline.
- Two test-only contract fixtures under `tests/support/`: a permutation truth
  with a combinatorial paytable and a multi-position book, and a choice-timed
  survival round with a seed pre-commitment and per-entity partial claims.
- Game-agnostic error codes `DEFINITION_MISMATCH`, `CLAIM_REJECTED`, and
  `INVALID_CHOICE`. The progressive market's `ADAPTER_MISMATCH`,
  `OPEN_REJECTED`, `SELL_REJECTED`, and `SETTLE_REJECTED` remain for wire
  compatibility.
- `src/modules/index.ts` module registry with `listModules`, `findModule`,
  `requireModule`, and the `UNKNOWN_MODULE` error code.
- Module-agnostic conformance runner and `reveal-engine/module-conformance-v1`
  report.
- `deriveMaxContinuations`, adopted from the adoption-bridge branch
  (`docs/adr/0001-branch-adoption.md`).
- Package subpaths `./modules` and `./modules/progressive-market`.
- `CommandLedger.creditClaim(theoretical, mint)`: prices a claim against the
  remaining ceiling, mints its receipt, and applies the credit as one step, so
  the cap chain cannot be half-performed. `creditWithinCap()` is a pure query
  and `applyCredit()` is the only call that moves the balance — a book that made
  the first without the second credited its full ceiling once per claim, with
  `capped: false` on every receipt. Both halves are now documented as mandatory
  in `docs/lifecycle-modules.md` §5, and `progressive-market` plus both fixtures
  go through the atomic call. See `docs/adr/0004`.
- `ModuleConformanceReport.ran`: how many times each declared check actually
  executed. `checks` states what was declared; `ran` states what was proved.
- `ENGINE_LIMITS.maxConformanceSeeds` (4,096), which was already the conformance
  runner's hard-coded bound.

### Changed

- The progressive-market lifecycle (single hidden truth, Bayesian evidence
  stream, single-position book) moved from the engine spine to
  `src/modules/progressive-market/`. It is now one module among several rather
  than the engine itself.
- `RoundBook` keeps its exact behavior and wire formats but now composes
  `CommandLedger` instead of owning idempotency, receipts, and cap accounting.
- **Breaking (core):** `CommandLedger.fundStake(amount, funding)` replaces
  `adoptCapBasis()` and `applyDebit()`. The cap basis accumulates externally
  funded stakes and ignores recycled winnings, instead of being pinned to the
  round's first stake — a single-basis chain crushed legitimate multi-position
  claims. The round invariant `liquidBalance <= capBasisStake * maxWinMultiple`
  is unchanged. `creditWithinCap()` on a round that has taken no stake now
  fails with `CLAIM_REJECTED` instead of silently crediting zero.
- **Breaking (core):** `TranscriptModel.commitmentBody` takes a fifth `choices`
  argument; `BookModel` requires `maxOpenClaims`; `StepModel` requires
  `beliefSpace`; `ConformanceModel` requires `references`.
- **Breaking (core):** `StepModel.belief` is optional when `beliefSpace` is
  `marginal` and required when it is `outcomes`. `weightVector` admits 2..64
  entries, so a marginal module whose per-item space is larger — a multi-deck
  shoe, a large field — previously could not satisfy the contract at all.
- `core/combinatorics.ts` bounds an exact count by `ENGINE_LIMITS.maxBigIntBits`
  and reports it as `INVALID_WEIGHTS`. `maxPermutationSize` (1,024) bounds
  shuffling and `maxBigIntBits` bounds what a `Rational` can carry — `536!` is
  4,092 bits — and the two used to disagree silently, surfacing as an
  `INVALID_RATIONAL` from another module.
- `stableJson` orders keys by UTF-16 code unit instead of `localeCompare`. It
  anchors `snapshotHash`, so its order must be a property of the bytes and not
  of the host's ICU data or default locale. No in-repo digest changes.
- `ENGINE_LIMITS.maxLoggedChoices` and `maxRoundClaims` are enforced —
  `defineLifecycleModule()` guards every choice-consuming entry point and
  validates the declared claim budget. Both were previously published and
  referenced by no code path.
- `risk.continuation.maxRides` is enforced by `RoundBook.open` instead of only
  being validated and fingerprinted.
- `reveal-conformance` iterates the module registry and each module's declared
  reference definitions instead of hard-coding the progressive market.
- Removed three duplicate core validators left by the extraction
  (`assertRecord`, `assertExactKeys`, `assertRevision`); the snapshot family
  they duplicated is unchanged.
- `./core` is game-agnostic. `./protocol`, `./serialization`, and `./reference`
  remain as deprecated aliases into the module, and every progressive-market
  symbol re-exported from the package root now carries the same `@deprecated`
  marker naming the subpath that owns it. The root barrel mixes engine surface
  with one module's API for 0.2 compatibility; nothing there said which was
  which. The README quickstart imports from the module subpath.
- `defineLifecycleModule()` validates every declaration it can reach: all five
  declared enums (`truth.kind`, `steps.choiceTiming`, `steps.beliefSpace`,
  `book.positions`, `book.settlement`), every mandatory hook, every optional
  hook that is present, `conformance.defaultSeeds`, and each conformance check's
  `code`, `description`, `scope`, and `run`. It previously accepted arbitrary
  strings for four of the enums — a `positions` or `settlement` typo routed a
  host down the wrong reserve-maths branch silently — and accepted a module with
  no `transcript.fromWire`, which is the untrusted-input boundary.
- `StepModel.maxSteps` is enforced: a derivation that returns more steps than the
  module declared fails with `DERIVATION_FAILED`. It previously had no consumer
  beyond its own range check.
- `TruthModel.encode` and `StepModel.encode` are load-bearing rather than
  decorative. `canonicalTranscriptBytes` composes the commitment body out of the
  same two functions the module declares, so the declared encoding _is_ the
  proof-bearing one; both test fixtures do the same, and a contract test rebuilds
  the sealed body from the declared encoders alone. No proof bytes moved.
- `checkModuleConformance` requires `seedCount >= 1`. Zero skipped every
  round-scoped check and still returned `ok: true` with all check codes listed.
- `blackSignalReference` derives its continuation policy instead of declaring
  it: `maxRides` 1 → 2, `adapterVersion` 1.0.0 → 1.1.0, and therefore a new
  fingerprint. This is the only intended replay-visible behavior change.
- `scripts/package-smoke.mjs` now packs, installs, and imports through the
  published `exports` map instead of reading `dist/` paths directly.
- README rewritten for a public audience with an explicit certification
  boundary and module map.

### Fixed

- **Money path.** `RoundBook.restore()` read `position.outcome` and
  `position.contingentPayout` out of the snapshot instead of deriving them, so a
  re-sealed reconnect payload could move a losing position onto the winning
  outcome or inflate its claim and settle for the difference (3,233 against an
  honest 0; the full 250,000 cap ceiling against an honest 1,940). Both are now
  re-derived: the outcome from the open receipt's `commandFingerprint`, the
  payout from the price replayed at `openedAtFrameRevision`. Present on `main`
  as well, and covered by conformance from now on.
- `CommandLedger.install()` rejects a receipt log that reuses an idempotency
  key. It keyed the receipt map by that key, so three receipts sharing one
  passed the dense-revision check, visited the module three times, and installed
  one — leaving the key live for replay.
- Hostile-input regression introduced by the relocation: `scopeOf()` in the
  progressive market's sampler wrappers read `context.gameId` before validating
  it, so `uniform`, `uniformBigInt`, `scopeOf`, and `roundIdentityOf` leaked a
  raw `TypeError` on a null context and reported the wrong code otherwise.
  Verified against `main` side by side: identical code and path on every
  malformed context.
- `assertSamplerScope` reports `INVALID_CONTEXT` for a malformed domain or round
  id instead of inheriting `INVALID_ADAPTER`.
- `fromWireReceipt`, the `CommandLedger` constructor, `checkModuleConformance`,
  `weightGcd`, and `reduceWeights` validate before dereferencing, so
  attacker-shaped wire data produces a typed failure rather than a `TypeError`.
- `deriveMaxContinuations` rejects a base round already below its floor instead
  of returning zero, which was indistinguishable from "no rides permitted".
- `assertClaimBudget` validated `openClaims` strictly and `maxOpenClaims` not at
  all, so `(5, undefined)`, `(5, NaN)`, and `(5, Infinity)` all passed:
  `openClaims >= maxOpenClaims` is `false` for every non-number. It was the only
  core assert in the repository that failed open, and the only core-side bound on
  simultaneous open claims. The budget is now validated as strictly as the count.
- A conformance check whose `scope` was neither `definition` nor `round` never
  ran, while `report.checks` still listed its code and `report.ok` was `true`. It
  is rejected at definition time and by the runner.
- Snapshot tamper cases in `tests/frozen-fixtures.test.ts`,
  `tests/replay-serialization.test.ts`, and the ordering fixture's
  `SNAPSHOT_NOT_REVALIDATED` check kept the original `snapshotHash`, so they were
  rejected by the checksum rather than on their merits — the weaker claim, and
  not the one the contract makes. They re-seal now.

### Unchanged (verified)

- `commit-v2`, `transcript-v1`, and `transcript-v2` verify by re-derivation, and
  `receipt-v1` and `round-book-v1` now have frozen fixtures of their own rather
  than runtime round trips.
- The stress correctness digest is byte-identical to 0.2 (`fdb9e9b8…baef1`), and
  the run now fails if it ever stops being.

## 0.2.0 — 2026-07-27

- Added the stable `api-v1` adapter/public contract, deep runtime validation, typed errors, adapter fingerprints, and mechanical conformance.
- Replaced ambiguous proof encoding with `commit-v2`, deterministic prior-weighted truth, bounded canonical transcript codecs, detailed failure taxonomy, and frozen v1/v2 fixtures.
- Rebuilt protocol frames, exact claims, command-bound idempotency, proof-bound settlement, cap-chain accounting, receipts, snapshots, and deterministic reconnect replay.
- Expanded independent oracle, exhaustive, deterministic property, malformed-input, adversarial race, serialization, package, stress, benchmark, and security evidence.
- Legacy `commit-v1` remains verification-only.

## 0.1.0 — 2026-07-27

- Initial private Axiom Games Reveal Engine foundation with two reference adapters and basic verification tooling.

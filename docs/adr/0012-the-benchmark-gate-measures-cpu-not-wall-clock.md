# ADR 0012 — The benchmark gate measures CPU time, not wall clock

- **Status:** accepted
- **Date:** 2026-07-30
- **Context branch:** `main`
- **Relates to:** 0011 (restore binding), `docs/evidence-ledger.md` § Reading these figures

## Context

`npm run bench` gated on absolute wall clock: `elapsedMs <= 20 s`,
`p99Ms <= 50 ms`, `eventsPerSecond >= 2000`. An adversarial review found the gate
failing on a developer laptop — 118.3 s, 446 events/s, p99 501 ms — and
concluded the committed `artifacts/benchmark-v3.json` (3.7 s, 14,168 events/s,
p99 7.9 ms) was a stale baseline recorded on different hardware, a 32x gap far
outside the ±20% run-to-run variance the evidence ledger declares.

That conclusion was wrong, and the way it was wrong is the reason for this ADR.

The machine was running an agent swarm: six of its processes had become zombies
and were still burning CPU. Measured directly rather than inferred:

| Run | wall clock | CPU time | ratio | `moduleDigests` |
| --- | --- | --- | --- | --- |
| starved | 298.4 s | 7.7 s | 39x | identical |
| starved | 375.7 s (140 events/s) | — | — | identical |
| loaded | 8.2–10.9 s | 4.24–4.37 s | 1.9–2.5x | identical |
| quiet | 5.4 s (9,700 events/s, p99 13 ms) | — | — | identical |
| committed baseline | 3.7 s (14,168 events/s) | — | — | identical |

Wall clock spanned two orders of magnitude on one machine within one hour. CPU
time held at ~4.2 s, stable to under 3%. The replay digests were byte-identical
in every run, including the ones the review read as evidence of foreign
hardware. A stale-hardware baseline cannot produce identical digests and a 100x
wall-clock spread on the same machine in the same hour; CPU starvation can, and
did.

Two further facts confirm the attribution. The reviewer's own control — a
worktree at the pre-fix baseline `efc8e42` — failed *identically*, which is what
happens when both runs are starved by the same contention, not evidence of a
stale anchor. And `npm run test:stress`, run on the same machine at the same
moment, passed: it costs ~1.8 s against a 30 s threshold (16x headroom) where
the benchmark cost ~3.7 s against 20 s (5.4x headroom). Same machine, same
contention, opposite verdicts — a headroom artifact, not a hardware difference.

## Decision

The benchmark records both clocks and gates only on CPU cost.

- `cpuMs` and `eventsPerCpuSecond` are compared against the committed baseline
  within a symmetric `maxRelativeDrift` band, alongside the workload identity
  (`samples`, `events`) and the `moduleDigests` correctness anchors.
- `elapsedMs`, `eventsPerSecond`, and the `latency` summary stay in the artifact
  as **information**. Nothing gates on them.

The rejected alternatives, and why:

- **Re-baseline the artifact on the current machine.** This was the first
  instinct and it is the trap. Re-baselining under contention writes a
  starvation artifact into the evidence ledger and calls it the machine's
  capability — replacing an accurate number with an inaccurate one while
  appearing to improve rigour. The committed 3.7 s figure was never stale.
- **Widen the thresholds until the observed run fits.** A band wide enough to
  admit 140 events/s is not a gate.
- **Drift against a baseline on the wall-clock metrics.** Strictly worse than
  the absolute thresholds it would replace: a ±20% band around a wall-clock
  figure has effectively zero headroom, so it fails on any concurrent load,
  which is precisely the false alarm this ADR exists to stop.

## Consequences

- The gate now catches what a benchmark gate is for — work this code newly does
  or newly stopped doing — and is indifferent to what else the machine is
  running. It no longer passes only on an idle laptop.
- `BenchmarkArtifact` gains `cpuMs` and `eventsPerCpuSecond`; `thresholds` is
  `{ maxRelativeDrift }`. This is an artifact schema change within `-v3`, and
  the committed baseline is re-taken once to carry the new fields.
- Re-taking the baseline still requires a quiet machine and still records the
  wall-clock figures, because those figures remain the honest answer to "how
  long does this take here" even though they are not gate inputs.
- `tests/artifact-schema.test.ts` pins the property directly: a starved run and
  a quiet run of identical work compare clean. A revision that puts wall clock
  back into the drift comparison fails that test.
- CPU time is not a portable capacity promise either. It moves with CPU
  architecture and Node version, both already recorded in `runtime`. Across
  machines it is evidence of workload shape, not of speed.
- **Robust is not immune.** CPU time degrades under pathological contention too,
  just far less: measured at a 12x starvation ratio the same workload consumed
  5.30 s rather than the quiet 4.25 s, about +25%, which would exceed a ±20%
  band. So a machine loaded that badly can still raise a false alarm — it takes
  a 12x oversubscription to do it, where wall clock needed none. The practical
  rule is unchanged and is the reason the band was not widened to hide this:
  take the baseline, and read a failure, on a quiet machine.

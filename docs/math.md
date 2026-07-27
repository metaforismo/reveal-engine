# Mathematical scope, theorem, and payable bounds

For outcome `i`, positive prior weight `w_i`, and evidence targeting `t` with likelihood weights `(a,b)`, the engine applies `w'_t = a·w_t` and `w'_i = b·w_i` for `i ≠ t`, then divides all weights by their GCD. This preserves exact ratios and yields `p_i = w_i / Σw` with exact normalization.

The first entry multiplier is `r/p_i`; an unshaded re-entry multiplier is `1/p_i`; pre-spread liquidation value is `p_i·claim`. The rational claim is not floored at entry.

## Within-round invariance theorem

For a finite declared likelihood model, truth sampled from declared priors, evidence sampled from that model, exact arithmetic, zero liquidation spread, no cap, no payable rounding, no continuation, self-financing re-entry, and a predictable strategy using only observed history, conditional claim value is a martingale. A first entry therefore has exact theoretical expectation `stake·r`; unshaded switches do not add another margin.

The exhaustive oracle tests cover hold, sell-after-evidence, and adaptive sell/re-entry policies on every two-tick binary path. Independent raw-weight tests cross-multiply against the engine across all bundled adapters.

## Payable boundary

With floor rounding, `0 ≤ theoretical − credited < 1` before a cap. For entry payout quantization, the expected loss is strictly less than the selected outcome probability. Spread and cap are monotone non-increasing adjustments. The engine never describes payable credits as exact theoretical equality.

Continuation/ride economics are outside the theorem. The current core validates continuation configuration but does not implement a production ride ledger. An adopter must model and test that state machine separately.

# Mathematical scope, theorem, and payable bounds

## Exact belief updates

Core represents a belief as a vector of non-negative BigInt weights with a
strictly positive total. Weights are reduced by their GCD after every update, so
ratios are preserved exactly and `p_i = w_i / Σw` is an exact rational. A weight
of zero is legal and means the outcome has been eliminated with posterior
_exactly_ zero — never an epsilon, never a float underflow.

The progressive market applies the symmetric Bayesian form: for outcome `i`,
positive prior weight `w_i`, and evidence targeting `t` with likelihood weights
`(a, b)`, it sets `w'_t = a·w_t` and `w'_i = b·w_i` for `i ≠ t`, then divides by
the common factor.

## Pricing

The first-entry multiplier is `r/p_i`; an unshaded re-entry multiplier is
`1/p_i`; pre-spread liquidation value is `p_i · claim`. The rational claim is not
floored at entry.

## Within-round invariance theorem

For a finite declared likelihood model, truth sampled from declared priors,
evidence sampled from that model, exact arithmetic, zero liquidation spread, no
cap, no payable rounding, no continuation, self-financing re-entry, and a
predictable strategy using only observed history, the conditional claim value is
a martingale. A first entry therefore has exact theoretical expectation
`stake·r`, and unshaded switches do not add another margin.

The exhaustive oracle tests cover hold, sell-after-evidence, and adaptive
sell/re-entry policies on every two-tick binary path. Independent raw-weight
tests cross-multiply against the engine across all bundled adapters.

Scope note: the theorem is a statement about the progressive-market lifecycle.
Other lifecycle modules make their own economic claims and owe their own
oracles; core guarantees only the arithmetic they are built from.

## Payable boundary

With floor rounding, `0 ≤ theoretical − credited < 1` before a cap. For entry
payout quantisation, the expected loss is strictly less than the selected outcome
probability. Spread and cap are monotone non-increasing adjustments. The engine
never describes payable credits as exact theoretical equality.

## Continuation

`deriveMaxContinuations(roundRtp, rtpFloor)` returns the largest continuation
count `n` for which `r^(n+1)` still clears the floor, computed in exact
rationals. It is a configuration helper, not a ride ledger: continuation
economics remain outside the theorem, and core validates continuation
configuration without implementing a production ride state machine. An adopter
must model and test that separately.

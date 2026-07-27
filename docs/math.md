# Mathematical scope and assumptions

For outcomes `i`, positive prior weights `w_i`, and an evidence event targeting `t` with positive likelihood weights `(a,b)`, the update is `w'_t = a w_t` and `w'_i = b w_i` for `i != t`. Therefore `p_i = w_i / sum(w)` is exact. A first entry pays `r/p_i`, where `r` is the configured theoretical RTP; unshaded re-entry pays `1/p_i`. Fair liquidation is `p_i * contingent-payout` before any configured spread.

Under these assumptions—finite known model, evidence generated from those likelihoods, exact arithmetic, zero liquidation spread, no cap, no payable rounding, no continuation, and a self-financing predictable within-round strategy—the conditional value is a martingale and the first entry's expected theoretical value is exactly `r` times stake. This does **not** establish equality for rounded credits, max-win caps, spreads, arbitrary operator timing, or ride/parlay chains. Those are separate product economics and must be measured independently.

The tests exhaustively enumerate short evidence schedules and adversarial strategies as regression guards; they are not a certification or a proof for an adopter's altered model.

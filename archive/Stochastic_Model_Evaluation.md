# Evaluation of `sm26.R` — MIM Stochastic RE Model

**Scope:** methodology and code review of the Monte Carlo DCF / credit model, plus a companion analytical overlay (`analytical_overlay.R`) that turns the raw 1,000-path output into properly-defined, interpretable risk numbers and adds a closed-form cross-check on the noisiest outputs.

---

## 1. What the model does (as built)

For each property type it runs `simct = 1000` paths. Each path:

1. Draws correlated annual revenue and expense growth (skew-normal marginals, Gaussian copula, ρ = 0.70) for years 2–11, using **CAGR-consistent drift** so the *expected* compounded growth matches the input 10-yr CAGR.
2. Evolves the cap-rate spread as a discrete mean-reverting (OU-type) process with a growth-feedback term and a random shock; `running_cap_rate = going-in cap + spread`.
3. Builds a 10-year unlevered cash flow, exits on **forward (Year-11) NOI ÷ Year-10 cap**, floors the exit value at 30% of cost, and computes an IRR.
4. Re-uses the *same* path for a terminal-maturity credit calc: default if `0.95 × exit value < loan`, with `LGD = (loan − recovery)/loan`, then `EL = PD × LGD`, annualized and mapped to a Moody's rating.

The architecture is sound and several things are done well. The rest of this document is mostly what I'd change, ordered by how much it affects the numbers.

---

## 2. Strengths

- **The Jensen correction is the right idea and correctly implemented.** `solve_mu_for_target_cagr()` solves for the annual arithmetic mean μ such that `E[mean(log1p(g))] = log1p(target_CAGR)`, baking volatility *and* skew into the fixed shock sample before solving. This is exactly what's needed so that drawing arithmetic growth rates doesn't systematically undershoot the target compounded CAGR. The `log_check` diagnostic verifies it in log space — good practice.
- **Gaussian copula for the rev/exp dependence** is the correct way to impose correlation while keeping skew-normal marginals, rather than correlating the raw draws.
- **`irr_safe()` and the solver's bracketing logic** are defensively written: sign-based bracket test, widening fallback, finite checks, and graceful degradation to the target on failure with reason-coded counters. That's better hygiene than most models of this type.
- **Reproducibility** is handled correctly: `furrr_options(seed = TRUE)` gives independent, reproducible parallel RNG streams, and the solver is seeded per property type.
- **Calibration diagnostics** (`log_check`, `corr_check`, `check_skew`, `calibration_table`) show the author is validating that realized draws match inputs — exactly the right instinct.

---

## 3. Issues that materially bias the outputs

### 3.1 The 30%-of-cost exit floor truncates the entire left tail (high impact)

`end_val <- pmax(end_val_raw, terminal_floor)` with `terminal_floor = 0.30 * value[1]` — and the identical floor on the debt side (`debt_terminal_floor`). This is the single most consequential line for risk metrics, because:

- **Equity:** it removes the left tail of IRR. Every downside risk number computed downstream (σ of IRR, Sortino, any VaR/CVaR) is measuring a distribution whose worst outcomes have been clipped. The metrics will look better than the model's own assumptions imply.
- **Credit:** it mechanically caps loss severity. With LTV ≈ 0.55–0.60 and recovery = 0.95 × (≥ 0.30 × cost), a floored default has `LGD ≈ (0.57 − 0.285)/0.57 ≈ 50%`. The model *cannot* produce a severe-loss scenario, so `Avg_LGD`, `Total_EL`, `Ann_EL` and therefore the **Moody's rating are biased optimistic** in precisely the tail that the rating is supposed to measure.

Recommendation: make the floor an explicit, defensible assumption (e.g. a recovery/liquidation floor on the *asset*, not a 30% hard floor on value), or remove it and let the cap-rate and NOI processes govern the tail. At minimum, expose it as a parameter and report metrics with and without it.

### 3.2 1,000 paths cannot resolve the credit metrics (high impact)

The rating buckets are in annual-EL **basis points** (Aaa ≤ 1 bp, Aa ≤ 4 bp, A ≤ 10 bp). To estimate a 1 bp annual EL you need to resolve default probabilities on the order of 10⁻³–10⁻⁴ over the 10-year horizon. With 1,000 paths the expected number of defaults for an investment-grade sleeve is between 0 and a handful, so:

- `PD` has a standard error comparable to its own value (a 0/1000 vs 3/1000 swing moves the rating by multiple notches).
- The ratings at the high-quality end are essentially **sampling noise**.

Recommendations, in order of preference: (a) raise `simct` to 10⁵–10⁶ for the credit pass specifically; (b) add importance sampling on the exit-value tail; or (c) use the **closed-form lognormal PD** in the overlay as the reported PD and keep the MC as a check. The overlay also prints exact-binomial confidence intervals so the noise is visible rather than hidden.

### 3.3 The OU cap-spread under-shoots the terminal target (medium impact)

The stochastic spread starts at 0 and mean-reverts toward `mu = capspread[1]` with `theta = 0.25`. After 9 steps the *expected* spread is `mu × (1 − 0.75⁹) ≈ 0.92 × mu`, so the **expected exit cap rate is below the base-case terminal cap**, biasing simulated exit values (and IRRs) slightly upward relative to the deterministic base case. `calibration_table$exit_cap_diff` already measures this; it's worth either raising θ, starting the spread partway toward the target, or reverting to the base-case glide as the mean path.

### 3.4 The growth → cap-rate feedback fattens the upside (medium impact)

`- 0.1 * growth_alpha` compresses the cap rate when realized growth beats assumption. Economically defensible (NOI growth drives cap compression), but it induces a positive correlation between NOI and exit multiple that **amplifies the right tail of value** and is governed by a hard-coded 0.1. Combined with §3.1 clipping the left tail, the value distribution is pushed right on both ends. Make the coefficient a named, documented parameter and sensitivity-test it.

### 3.5 Annualizing 10-yr EL by ÷10 (medium impact)

`Ann_EL = Total_EL / 10` assumes losses arrive linearly. The horizon-consistent conversion is `Ann_EL = 1 − (1 − Total_EL)^(1/10)` (or a hazard-rate formulation). The difference is small at low EL but grows for the lower-rated buckets where it matters most for pricing the loss-adjusted spread. The overlay reports the hazard-consistent figure alongside.

---

## 4. Conceptual / interpretation issues

### 4.1 "Equity IRR" is actually unlevered

`cf_vec` starts with `-value[1]` (the full purchase price, no debt) — so `irr_value` is an **unlevered asset IRR**, not equity. The debt module sits beside it but never feeds a levered equity cash flow. Either rename to `asset_IRR`/`unlevered_IRR`, or build a true levered equity IRR (purchase − loan at t0, NOI − debt service in interim, exit value − loan payoff at t10). As written, the label invites misreading.

### 4.2 The "Sharpe" and "Sortino" are cross-sectional, not time-series

`sd_IRR` is the dispersion of a 10-year IRR *across simulations* — terminal-outcome uncertainty — not the volatility of a return stream. Dividing `(mean_IRR − rf)` by it is a defensible *risk-adjusted-outcome* ratio, but it is **not** a Sharpe ratio in the textbook sense, and `rf = 4.25%` is an annual rate compared against a 10-yr IRR with no horizon adjustment. Keep the metric if useful, but label it as a "spread-to-hurdle per unit of outcome dispersion" so it isn't compared to published Sharpe ratios.

### 4.3 The downside-deviation formula is wrong

```r
downside_deviation <- sd(pmax(0, mar - irr_values))
```
`sd()` subtracts the *mean shortfall* and divides by n−1, so this is the standard deviation of the shortfall series, not downside deviation. The standard definition is the root-mean-square of below-target shortfalls:

```r
dd <- sqrt(mean(pmin(0, irr_values - mar)^2, na.rm = TRUE))
```

This changes the Sortino ratio non-trivially. The overlay implements the corrected version.

---

## 5. Code-quality / robustness

- **`MASS::mvrnorm` is used but `library(MASS)` is commented out** (lines 17, 336). It works only if MASS happens to be installed; if not, every simulation errors. Either add `library(MASS)` (and keep `dplyr::select` qualified, which the code already does) or switch to `mvtnorm::rmvnorm`.
- **Leftover debug `cat("DEBUG: ...")`** inside the solver (line ~192) fires on every solver call and spams the console. Remove or gate behind a `verbose` flag.
- **`options(shiny.error = browser)`** (line 889) drops the app into the debugger on any reactive error. Fine for development, dangerous if this is ever shared/deployed — remove for anything but local debugging.
- **`vol_mult`** is plumbed through `add_and_grow_rows` but always 1.0 — dead parameter, or wire it to a stress-test control.
- **Heavy reliance on hard-coded indices** (`[10]`, `[11]`, `slice(1:11)`, `hold_period = 11`). It's internally consistent but fragile; a single change to the hold period breaks several disconnected spots. Consider deriving these from one `HOLD` constant.
- **Per-year `mvrnorm` calls** (one draw per year inside the loop) assume growth is independent across years (no autocorrelation). Reasonable, but it's an implicit assumption worth stating; vectorizing the draws would also speed the inner loop.
- **`run_base_case_loan` computes `LTV`, `DSCR`, `Debt_Yield` on a deterministic path** but the stochastic credit module ignores all interim coverage — default is terminal-only. If interim covenant/refi risk matters, the credit model is structurally silent on it.

---

## 6. Priority list

| # | Fix | Effort | Impact |
|---|-----|--------|--------|
| 1 | Re-justify or remove the 30%-of-cost exit floor (§3.1) | Low | High |
| 2 | Resolve credit tail with more paths / IS / closed-form PD (§3.2) | Med | High |
| 3 | Correct downside-deviation / Sortino (§4.3) | Low | Med |
| 4 | Hazard-consistent EL annualization (§3.5) | Low | Med |
| 5 | Fix OU terminal under-shoot (§3.3) and document the growth feedback (§3.4) | Low | Med |
| 6 | Rename unlevered IRR / relabel Sharpe (§4.1–4.2) | Low | Clarity |
| 7 | `library(MASS)`, kill debug `cat`, remove `shiny.error=browser` (§5) | Low | Robustness |

---

## 7. The analytical overlay (how to read the outputs)

`analytical_overlay.R` is a drop-in layer that consumes the objects the model already builds (`irr_results`, `random_variables`, `debt_raw`, `data`) and produces an **interpretation layer** so the 1,000-path dump becomes decision-ready numbers. It adds, per property type:

- **Monte Carlo precision:** standard errors and 95% CIs on mean IRR, PD, and EL, so users can see when a difference is real vs noise.
- **A proper risk profile of IRR:** percentiles, P(IRR < hurdle), P(loss), and 5% VaR/CVaR — with the *corrected* downside deviation and Sortino.
- **A closed-form cross-check on the credit tail:** it reconstructs the unfloored exit-value distribution from the stored paths, fits a lognormal, and computes a **closed-form PD and EL** that don't suffer the 1,000-path noise of §3.2. It prints the analytic PD next to the empirical PD and an exact-binomial CI, so divergence between them flags either too few paths or a non-lognormal tail.
- **Jensen gap:** mean simulated IRR vs the deterministic base-case IRR, so the user can see how much of the spread is convexity vs assumption.
- **A one-screen interpretation guide** describing exactly what each number means and its known biases (esp. the floor).

It runs as standalone tables and as an added Shiny tab. See the header of the file for how to source it.

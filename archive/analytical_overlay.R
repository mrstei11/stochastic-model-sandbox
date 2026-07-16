# =====================================================================
# ANALYTICAL OUTPUT-INTERPRETATION OVERLAY  for  sm26.R
# =====================================================================
# PURPOSE
#   Turns the raw 1,000-path Monte Carlo dump into decision-ready,
#   properly-defined risk numbers, and adds a closed-form cross-check
#   on the credit tail (which 1,000 paths cannot resolve).
#
# HOW TO USE
#   Source this file AFTER the model has built its objects and BEFORE
#   shinyApp(...).  In sm26.R, paste:
#
#       source("analytical_overlay.R")     # right after `base_case_dcfs <- ...`
#
#   It consumes objects the model already creates:
#       irr_results, random_variables, debt_raw, data, base_case_dcfs
#   and creates:
#       irr_risk_overlay, credit_overlay, precision_overlay
#   plus print_overlay_guide().  A ready-to-paste Shiny tab is at the
#   bottom of this file.
#
# DEPENDS: dplyr, tibble, stats  (all already loaded by sm26.R)
# =====================================================================

suppressWarnings(suppressMessages({
  library(dplyr)
  library(tibble)
}))

# ---- Interpretation parameters (single place to change) -------------
OVL_HURDLE   <- 0.07     # MAR / hurdle rate used for shortfall metrics
OVL_RF       <- 0.0425   # "risk-free" used in the outcome-dispersion ratio
OVL_HOLD     <- 10       # IRR horizon in years (for EL annualization)
OVL_TAIL     <- 0.05     # VaR / CVaR tail probability
OVL_HAIRCUT  <- 0.95     # liquidation recovery factor (must match sm26.R)
OVL_FLOOR    <- 0.30     # exit-value floor as fraction of cost (match sm26.R)
OVL_NSMOOTH  <- 200000L  # parametric-bootstrap size for smoothed credit metrics

# =====================================================================
# 1. MONTE CARLO PRECISION  — is a difference real or just noise?
# =====================================================================
# Reports standard errors / 95% CIs on the headline estimates so the
# user knows the resolution of the simulation.
precision_overlay <- local({

  # ---- IRR precision ----
  irr_prec <- irr_results %>%
    dplyr::group_by(proptype) %>%
    dplyr::summarize(
      n_irr        = sum(is.finite(IRR)),
      mean_IRR     = mean(IRR, na.rm = TRUE),
      se_mean_IRR  = sd(IRR, na.rm = TRUE) / sqrt(pmax(1, sum(is.finite(IRR)))),
      .groups = "drop"
    ) %>%
    dplyr::mutate(
      mean_IRR_lo95 = mean_IRR - 1.96 * se_mean_IRR,
      mean_IRR_hi95 = mean_IRR + 1.96 * se_mean_IRR
    )

  # ---- PD / EL precision (per-sim loss = is_default * loss_sev) ----
  cred_prec <- debt_raw %>%
    dplyr::mutate(loss = is_default * loss_sev) %>%
    dplyr::group_by(proptype) %>%
    dplyr::summarize(
      n_sims  = dplyr::n(),
      n_def   = sum(is_default),
      PD      = mean(is_default),
      EL      = mean(loss),
      se_EL   = sd(loss) / sqrt(dplyr::n()),
      .groups = "drop"
    ) %>%
    dplyr::rowwise() %>%
    dplyr::mutate(
      # exact (Clopper-Pearson) binomial CI on PD
      PD_lo95 = stats::binom.test(n_def, n_sims)$conf.int[1],
      PD_hi95 = stats::binom.test(n_def, n_sims)$conf.int[2],
      EL_lo95 = max(0, EL - 1.96 * se_EL),
      EL_hi95 = EL + 1.96 * se_EL,
      # flag when the simulation cannot resolve the rating bucket
      PD_resolved = n_def >= 10
    ) %>%
    dplyr::ungroup()

  dplyr::left_join(irr_prec, cred_prec, by = "proptype")
})

# =====================================================================
# 2. IRR RISK PROFILE  — what the equity outcome distribution means
#    (with the CORRECTED downside-deviation / Sortino from the review)
# =====================================================================
downside_deviation <- function(r, mar) {
  # root-mean-square of below-target shortfalls (the correct definition)
  sqrt(mean(pmin(0, r - mar)^2, na.rm = TRUE))
}

irr_risk_overlay <- local({

  base_irr <- tryCatch(
    base_case_dcfs %>%
      dplyr::group_by(proptype) %>%
      dplyr::summarize(base_case_IRR = dplyr::first(IRR), .groups = "drop"),
    error = function(e) NULL
  )

  out <- irr_results %>%
    dplyr::group_by(proptype) %>%
    dplyr::summarize(
      mean_IRR   = mean(IRR, na.rm = TRUE),
      median_IRR = median(IRR, na.rm = TRUE),
      sd_IRR     = sd(IRR, na.rm = TRUE),
      p05 = quantile(IRR, 0.05, na.rm = TRUE),
      p10 = quantile(IRR, 0.10, na.rm = TRUE),
      p25 = quantile(IRR, 0.25, na.rm = TRUE),
      p75 = quantile(IRR, 0.75, na.rm = TRUE),
      p90 = quantile(IRR, 0.90, na.rm = TRUE),
      p95 = quantile(IRR, 0.95, na.rm = TRUE),
      prob_below_hurdle = mean(IRR < OVL_HURDLE, na.rm = TRUE),
      prob_loss         = mean(IRR < 0,          na.rm = TRUE),
      VaR_5  = quantile(IRR, OVL_TAIL, na.rm = TRUE),                 # 5th pct IRR
      CVaR_5 = mean(IRR[IRR <= quantile(IRR, OVL_TAIL, na.rm = TRUE)], na.rm = TRUE),
      downside_dev = downside_deviation(IRR, OVL_HURDLE),
      .groups = "drop"
    ) %>%
    dplyr::mutate(
      # corrected Sortino (vs hurdle) and a relabeled outcome-dispersion ratio
      sortino_corrected      = (mean_IRR - OVL_HURDLE) / downside_dev,
      outcome_dispersion_ratio = (mean_IRR - OVL_RF) / sd_IRR   # NOT a true Sharpe
    )

  if (!is.null(base_irr)) {
    out <- out %>%
      dplyr::left_join(base_irr, by = "proptype") %>%
      dplyr::mutate(jensen_gap = mean_IRR - base_case_IRR)   # convexity vs assumption
  }
  out
})

# =====================================================================
# 3. CLOSED-FORM CREDIT CROSS-CHECK
#    1,000 paths can't resolve a PD of a few bps (see review s3.2).
#    We reconstruct the UNFLOORED exit-value distribution from the
#    stored paths, fit a lognormal, and compute:
#      (a) closed-form PD  = P(V_raw < loan/haircut)   [exact under LN]
#      (b) a parametric-bootstrap PD/LGD/EL using the model's OWN loss
#          rule (incl. the 30% floor) on OVL_NSMOOTH lognormal draws.
#    Note: the 30% floor affects LGD but NOT the default boundary, so
#    (a) is a clean check of the empirical PD.
# =====================================================================
credit_overlay <- local({

  # ---- reconstruct unfloored exit value per simulation ----
  exitv <- random_variables %>%
    dplyr::arrange(proptype, simulation_id, year) %>%
    dplyr::group_by(proptype, simulation_id) %>%
    dplyr::summarize(
      fwd_noi  = dplyr::nth(revenue, 11) - dplyr::nth(expense, 11),
      cap_y10  = dplyr::nth(running_cap_rate, 10),
      .groups = "drop"
    ) %>%
    dplyr::mutate(
      exit_cap = pmax(0.03, cap_y10),
      V_raw    = fwd_noi / exit_cap
    ) %>%
    dplyr::filter(is.finite(V_raw), V_raw > 0)

  # ---- per-proptype loan terms ----
  terms <- data %>%
    dplyr::group_by(proptype) %>%
    dplyr::summarize(
      value = dplyr::first(value),
      ltv   = dplyr::first(ltv),
      .groups = "drop"
    ) %>%
    dplyr::mutate(
      loan      = ltv * value,
      threshold = loan / OVL_HAIRCUT,     # default boundary on unfloored value
      floor_val = OVL_FLOOR * value
    )

  # ---- empirical PD/EL from debt_raw (the model's own output) ----
  emp <- debt_raw %>%
    dplyr::mutate(loss = is_default * loss_sev) %>%
    dplyr::group_by(proptype) %>%
    dplyr::summarize(
      PD_emp = mean(is_default),
      EL_emp = mean(loss),
      .groups = "drop"
    )

  # ---- analytic + smoothed metrics ----
  res <- exitv %>%
    dplyr::group_by(proptype) %>%
    dplyr::summarize(
      meanlog = mean(log(V_raw)),
      sdlog   = sd(log(V_raw)),
      n_paths = dplyr::n(),
      .groups = "drop"
    ) %>%
    dplyr::left_join(terms, by = "proptype") %>%
    dplyr::rowwise() %>%
    dplyr::mutate(
      # (a) closed-form PD under lognormal fit
      PD_analytic = stats::pnorm((log(threshold) - meanlog) / sdlog),

      # (b) parametric bootstrap with the model's exact loss rule
      EL_smooth  = {
        set.seed(7)
        Vs  <- stats::rlnorm(OVL_NSMOOTH, meanlog, sdlog)
        rec <- OVL_HAIRCUT * pmax(Vs, floor_val)        # recovery incl. 30% floor
        d   <- rec < loan
        lgd <- ifelse(d, (loan - rec) / loan, 0)
        mean(lgd)                                       # EL = mean loss
      },
      LGD_smooth = {
        set.seed(7)
        Vs  <- stats::rlnorm(OVL_NSMOOTH, meanlog, sdlog)
        rec <- OVL_HAIRCUT * pmax(Vs, floor_val)
        d   <- rec < loan
        if (any(d)) mean((loan - rec[d]) / loan) else 0
      }
    ) %>%
    dplyr::ungroup() %>%
    dplyr::left_join(emp, by = "proptype") %>%
    dplyr::mutate(
      # hazard-consistent annualization (review s3.5) vs the model's /10
      Ann_EL_hazard_bps = (1 - (1 - EL_smooth)^(1 / OVL_HOLD)) * 1e4,
      Ann_EL_linear_bps = (EL_smooth / OVL_HOLD) * 1e4,
      PD_gap_bps        = (PD_analytic - PD_emp) * 1e4   # analytic vs MC noise
    ) %>%
    dplyr::select(
      proptype, n_paths,
      PD_emp, PD_analytic, PD_gap_bps,
      EL_emp, EL_smooth, LGD_smooth,
      Ann_EL_linear_bps, Ann_EL_hazard_bps
    )

  res
})

# =====================================================================
# 4. INTERPRETATION GUIDE  — what each number means, and its caveats
# =====================================================================
print_overlay_guide <- function() {
  cat("
=====================================================================
HOW TO READ THE OVERLAY OUTPUTS
=====================================================================

precision_overlay  -- resolution of the simulation
  mean_IRR (+/- se, 95% CI) : a difference between property types is
        only meaningful if the CIs do not overlap.
  PD with exact binomial CI : if PD_resolved == FALSE (fewer than ~10
        simulated defaults) the PD -- and any rating built on it -- is
        sampling noise. Use PD_analytic from credit_overlay instead.

irr_risk_overlay  -- the equity (UNLEVERED) outcome distribution
  prob_below_hurdle : chance the deal returns less than the hurdle.
  prob_loss         : chance of a negative IRR.
  VaR_5 / CVaR_5    : 5th-percentile IRR and the average IRR in that
        worst 5%. NOTE: the 30%-of-cost exit floor in sm26.R clips the
        true left tail, so these UNDERSTATE downside.
  sortino_corrected : uses the correct downside-deviation formula
        (root-mean-square shortfall vs hurdle), unlike the original.
  outcome_dispersion_ratio : (mean_IRR - rf)/sd_IRR. This is a
        cross-sim outcome ratio, NOT a time-series Sharpe -- do not
        compare it to published Sharpe ratios.
  jensen_gap        : mean simulated IRR minus the deterministic base
        case. Positive = convexity from volatility/skew; it is NOT
        alpha.

credit_overlay  -- the loan loss picture, de-noised
  PD_emp vs PD_analytic : empirical (1,000-path, noisy) vs closed-form
        lognormal PD. Large PD_gap_bps means too few paths OR a
        non-lognormal exit tail -- investigate before trusting the MC.
  EL_smooth / LGD_smooth : parametric-bootstrap (200k draws) using the
        model's exact loss rule, far less noisy than the 1,000-path EL.
  Ann_EL_hazard_bps vs Ann_EL_linear_bps : the hazard figure is the
        horizon-consistent annualization; the linear one replicates the
        model's EL/10 for comparison. Map the HAZARD bps to ratings.

KEY CAVEAT carried from the model: the 30%-of-cost exit floor caps loss
severity (~50% max LGD) and clips equity downside. Every downside number
here inherits that optimism until the floor is revisited.
=====================================================================
")
}

# ---- auto-print on source ----
cat("\n================ ANALYTICAL OVERLAY ================\n")
cat("\n[1] MONTE CARLO PRECISION (mean IRR, PD, EL with CIs)\n")
print(as.data.frame(precision_overlay), digits = 4)
cat("\n[2] IRR RISK PROFILE (percentiles, P(<hurdle), VaR/CVaR, Sortino)\n")
print(as.data.frame(irr_risk_overlay), digits = 4)
cat("\n[3] CREDIT: EMPIRICAL vs CLOSED-FORM (de-noised PD/EL)\n")
print(as.data.frame(credit_overlay), digits = 4)
print_overlay_guide()

# =====================================================================
# 5. OPTIONAL: drop-in Shiny tab
# ---------------------------------------------------------------------
# Add this tabPanel inside tabsetPanel(...) in the UI:
#
#   tabPanel("Analytical Overlay",
#     br(),
#     h3("Monte Carlo precision"),
#     p("Standard errors / CIs. PD_resolved == FALSE means the rating is noise."),
#     DTOutput("precisionTable"),
#     hr(),
#     h3("IRR risk profile (corrected Sortino, VaR/CVaR, Jensen gap)"),
#     DTOutput("irrRiskTable"),
#     hr(),
#     h3("Credit: empirical vs closed-form (de-noised)"),
#     p("Large PD_gap_bps flags too-few-paths or a non-lognormal tail."),
#     DTOutput("creditOverlayTable")
#   )
#
# Add these to server(...):
#
#   output$precisionTable    <- renderDT(datatable(precision_overlay,
#                                 options = list(dom = "t", scrollX = TRUE)))
#   output$irrRiskTable      <- renderDT(datatable(irr_risk_overlay,
#                                 options = list(dom = "t", scrollX = TRUE)))
#   output$creditOverlayTable<- renderDT(datatable(credit_overlay,
#                                 options = list(dom = "t", scrollX = TRUE)))
# =====================================================================

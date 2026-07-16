# =========================
# MIM Stochastic RE Model
# Adds:
# (5) CAGR-consistent growth (inputs are true 10yr CAGRs)
# IRR safety fix:
# - Prevent FinCal::irr() uniroot crashes using irr_safe()
# =========================

# Load necessary libraries
library(readxl)
library(dplyr)
library(FinCal)
library(purrr)
library(sn)
library(ggplot2)
library(shiny)
#library(MASS)
library(DT)
library(scales)
library(shinythemes)
library(furrr)
library(future)
library(moments)

plan(multisession, workers = parallel::detectCores() - 1)

# ========== Base assumptions

simct <- 1000

BASE_SOFR <- 0.0363   # Current SOFR (April 2026)

GROWTH_FLOOR <- -0.95   # must match solver and simulation

# --- Solver diagnostics (global counters) ---
SOLVER_CALLS <- 0L
SOLVER_FAILS <- 0L
SOLVER_FAIL_REASONS <- list(
  bad_inputs = 0L,
  nonfinite_bracket = 0L,
  no_bracket = 0L,
  uniroot_error = 0L
)

# --- DATA LOADING ---
file_path <- "S:/RRA/8. Research_Real Estate/Ad Hoc/2025/stochasticmodel/TESTDCF8_test7.xlsx"
data <- read_excel(file_path)

debt_terms <- read_excel(
  "S:/RRA/8. Research_Real Estate/Ad Hoc/2025/stochasticmodel/DEBTTERMS.xlsx"
) %>%
  rename(
    proptype   = Sector,
    spread_bps = Spread,
    ltv        = LTV,
    debt_yield = `Debt Yield`
  ) %>%
  mutate(spread = spread_bps / 10000)  # bps → decimal

data <- data %>%
  left_join(debt_terms, by = "proptype")



# --- CORE FUNCTIONS ---

get_moodys_rating <- function(annual_el) {
  if (is.na(annual_el)) return("N/A")
  if (annual_el <= 0.0001) return("Aaa")
  if (annual_el <= 0.0004) return("Aa")
  if (annual_el <= 0.0010) return("A")
  if (annual_el <= 0.0025) return("Baa")
  if (annual_el <= 0.0075) return("Ba")
  if (annual_el <= 0.0250) return("B")
  return("Caa-C")
}

map_dial_to_skewness <- function(dial, max_abs_skew = 0.3) {
  if (is.na(dial) || !is.finite(dial)) dial <- 0
  dial <- pmax(pmin(dial, 100), -100)
  max_abs_skew * tanh(dial / 50)
}

rsn_cp <- function(n, mean, sd, dial, max_abs_skew = 0.3) {
  if (is.na(mean) || is.na(sd) || sd <= 0) return(rep(NA_real_, n))
  if (is.na(dial)) dial <- 0
  gamma1 <- map_dial_to_skewness(dial, max_abs_skew)
  shrink <- c(1, 0.85, 0.7, 0.55, 0.4, 0.25, 0.1, 0)
  for (s in shrink) {
    dp <- tryCatch(
      sn::cp2dp(c(mean, sd, gamma1 * s), family = "SN"),
      error = function(e) NULL
    )
    if (!is.null(dp)) return(sn::rsn(n, dp = dp))
  }
  rnorm(n, mean, sd)
}

# ============================================================
# IRR SAFETY FIX (NEW): Prevent FinCal::irr() uniroot crashes
# ============================================================
irr_safe <- function(cf) {
  if (any(!is.finite(cf)) || any(is.na(cf))) return(NA_real_)
  if (!(any(cf < 0) && any(cf > 0))) return(NA_real_)
  tryCatch(
    FinCal::irr(cf),
    error = function(e) NA_real_
  )
}

# ============================================================
# NEW (1): Solve for annual mean so compounded CAGR matches input
# ============================================================
# Helper: build dp with the same shrink fallback logic
build_dp_safe <- function(mu, sd, dial, max_abs_skew = 0.3) {
  gamma1 <- map_dial_to_skewness(dial, max_abs_skew)
  shrink <- c(1, 0.85, 0.7, 0.55, 0.4, 0.25, 0.1, 0)
  
  for (s in shrink) {
    dp <- tryCatch(
      sn::cp2dp(c(mu, sd, gamma1 * s), family = "SN"),
      error = function(e) NULL
    )
    if (!is.null(dp)) return(dp)
  }
  NULL
}

# Deterministic solver: fixes the uniroot/noise problem
solve_mu_for_target_cagr <- function(target_cagr, sd, dial,
                                     n_mc = 100000,
                                     clamp_min = GROWTH_FLOOR,
                                     max_abs_skew = 0.3,
                                     seed = 123) {
  
  SOLVER_CALLS <<- SOLVER_CALLS + 1L
  
  if (is.na(target_cagr) || is.na(sd) || sd <= 0) {
    SOLVER_FAILS <<- SOLVER_FAILS + 1L
    SOLVER_FAIL_REASONS$bad_inputs <<- SOLVER_FAIL_REASONS$bad_inputs + 1L
    return(target_cagr)
  }
  
  target_log <- log1p(target_cagr)
  
  # fixed shocks (mean 0), skew/vol baked in
  set.seed(seed)
  eps <- rsn_cp(n_mc, mean = 0, sd = sd, dial = dial, max_abs_skew = max_abs_skew)
  bad <- !is.finite(eps)
  if (any(bad)) eps[bad] <- rnorm(sum(bad), mean = 0, sd = sd)
  
  f <- function(mu) {
    g <- pmax(eps + mu, clamp_min)
    val <- mean(log1p(g), na.rm = TRUE) - target_log
    if (!is.finite(val)) return(ifelse(mu > target_cagr, 1e6, -1e6))
    val
  }
  
  lo <- max(clamp_min + 1e-6, target_cagr - 20 * sd)
  hi <- target_cagr + 20 * sd
  
  f_lo <- f(lo); f_hi <- f(hi)
  if (!is.finite(f_lo) || !is.finite(f_hi)) {
    SOLVER_FAILS <<- SOLVER_FAILS + 1L
    SOLVER_FAIL_REASONS$nonfinite_bracket <<- SOLVER_FAIL_REASONS$nonfinite_bracket + 1L
    return(target_cagr)
  }
  
  # If either endpoint is already essentially a root, return it
  if (abs(f_lo) < 1e-10) return(lo)
  if (abs(f_hi) < 1e-10) return(hi)
  
  # Proper bracket test using signs (uniroot's logic)
  if (sign(f_lo) == sign(f_hi)) {
    lo2 <- max(clamp_min + 1e-6, target_cagr - 30 * sd)
    hi2 <- target_cagr + 30 * sd
    f_lo2 <- f(lo2); f_hi2 <- f(hi2)
    
    if (abs(f_lo2) < 1e-10) return(lo2)
    if (abs(f_hi2) < 1e-10) return(hi2)
    
    if (is.finite(f_lo2) && is.finite(f_hi2) && sign(f_lo2) != sign(f_hi2)) {
      lo <- lo2; hi <- hi2
    } else {
      SOLVER_FAILS <<- SOLVER_FAILS + 1L
      SOLVER_FAIL_REASONS$no_bracket <<- SOLVER_FAIL_REASONS$no_bracket + 1L
      return(target_cagr)
    }
  }
  
  
cat("DEBUG:", "target=", target_cagr, "sd=", sd, "dial=", dial,
      "f_lo=", f_lo, "f_hi=", f_hi, "signs=", sign(f_lo), sign(f_hi), "\n")
  
out <- tryCatch(
  uniroot(f, lower = lo, upper = hi, tol = 1e-7)$root,
  error = function(e) {
    message("uniroot error: ", conditionMessage(e))
    NA_real_
  }
)

  
  if (!is.finite(out)) {
    SOLVER_FAILS <<- SOLVER_FAILS + 1L
    SOLVER_FAIL_REASONS$uniroot_error <<- SOLVER_FAIL_REASONS$uniroot_error + 1L
    return(target_cagr)
  }
  
  out
}


# ============================================================
# Precompute CAGR-consistent annual means (once)
# ============================================================
mu_adjustments <- data %>%
  group_by(proptype) %>%
  summarize(
    seed0 = 1000 + cur_group_id(),
    
    drev_mu_adj = solve_mu_for_target_cagr(
      target_cagr = first(drevenue),
      sd          = first(stdevrev),
      dial        = first(skewrev),
      seed        = seed0
    ),
    
    dexp_mu_adj = solve_mu_for_target_cagr(
      target_cagr = first(dexpense),
      sd          = first(stdevexpense),
      dial        = first(skewexpense),
      seed        = seed0 + 5000
    ),
    
    .groups = "drop"
  ) %>%
  dplyr::select(-seed0)   # IMPORTANT: dplyr::select (MASS masks select)

cat(
  "\n--- Jensen solver diagnostics ---\n",
  "Calls:", SOLVER_CALLS, "\n",
  "Fails:", SOLVER_FAILS, "\n",
  "Fail rate:", round(SOLVER_FAILS / max(1L, SOLVER_CALLS), 3), "\n",
  "Fail reasons:\n",
  "  bad_inputs:", SOLVER_FAIL_REASONS$bad_inputs, "\n",
  "  nonfinite_bracket:", SOLVER_FAIL_REASONS$nonfinite_bracket, "\n",
  "  no_bracket:", SOLVER_FAIL_REASONS$no_bracket, "\n",
  "  uniroot_error:", SOLVER_FAIL_REASONS$uniroot_error, "\n",
  "-------------------------------\n"
)

# Join the adjustments onto the main data BEFORE any mu_debug
data <- data %>% left_join(mu_adjustments, by = "proptype")

property_types <- sort(unique(data$proptype))

# Quick diagnostic (now it will be valid)
mu_debug <- data %>%
  group_by(proptype) %>%
  summarize(
    input_drev = first(drevenue),
    mu_rev     = first(drev_mu_adj),
    bump_rev_bps = (mu_rev - input_drev) * 10000,
    
    input_dexp = first(dexpense),
    mu_exp     = first(dexp_mu_adj),
    bump_exp_bps = (mu_exp - input_dexp) * 10000,
    
    sd_rev = first(stdevrev),
    sd_exp = first(stdevexpense),
    .groups = "drop"
  ) %>%
  arrange(desc(bump_exp_bps))

print(mu_debug)

# --- Base case (deterministic) DCF: "random draw" = assumptions ---
# Cap rate path: start at going-in cap rate, linearly move to terminal cap by Year 11
add_base_case_rows <- function(df) {
  
  hold_period <- 11  # years 1..11
  
  expanded_df <- df %>%
    slice(rep(1, hold_period)) %>%
    mutate(
      year = NA_real_,
      revenue = NA_real_,
      expense = NA_real_,
      capex = NA_real_,
      capspread = NA_real_,
      running_cap_rate = NA_real_
    )
  
  # Initialize year 1
  expanded_df$year[1]    <- df$year[1]
  expanded_df$revenue[1] <- df$revenue[1]
  expanded_df$expense[1] <- df$expense[1]
  expanded_df$capex[1]   <- df$capex[1]
  
  # ---- NEW: cap rate path reaches terminal at Year 10 and stays flat in Year 11 ----
  cap0 <- df$caprate[1]                      # going-in cap rate
  capT <- df$caprate[1] + df$capspread[1]    # terminal cap rate (target at Year 10)
  
  t_index <- 0:(hold_period - 1)             # 0..10 for years 1..11
  phase   <- pmin(t_index, 9) / 9            # 0..1 by Year 10; flat afterward
  
  expanded_df$running_cap_rate <- cap0 + (capT - cap0) * phase
  expanded_df$capspread        <- expanded_df$running_cap_rate - cap0
  # -------------------------------------------------------------------------------
  
  for (i in 2:hold_period) {
    # Base-case growth = assumptions
    expanded_df$revenue[i] <- expanded_df$revenue[i - 1] * (1 + df$drevenue[1])
    expanded_df$expense[i] <- expanded_df$expense[i - 1] * (1 + df$dexpense[1])
    
    # Base-case capex = assumption
    expanded_df$capex[i] <- df$capex[1]
    
    expanded_df$year[i] <- expanded_df$year[i - 1] + 1
  }
  
  expanded_df
}

# ============================================================
# Correlated skew-normal growth draws (Gaussian copula) -- robust
# ============================================================
draw_correlated_growth <- function(
    mu_rev, sd_rev, skew_rev,
    mu_exp, sd_exp, skew_exp,
    rho = 0.70,
    max_abs_skew = 0.3
) {
  # 1) Correlated standard normals
  z <- MASS::mvrnorm(
    1,
    mu = c(0, 0),
    Sigma = matrix(c(1, rho, rho, 1), nrow = 2)
  )
  
  # 2) Convert to uniforms
  u_rev <- pnorm(z[1])
  u_exp <- pnorm(z[2])
  
  # 3) Build skew-normal parameterizations with shrink fallback (like rsn_cp)
  gamma_rev <- map_dial_to_skewness(skew_rev, max_abs_skew)
  gamma_exp <- map_dial_to_skewness(skew_exp, max_abs_skew)
  
  shrink <- c(1, 0.85, 0.7, 0.55, 0.4, 0.25, 0.1, 0)
  
  dp_rev <- NULL
  for (s in shrink) {
    dp_rev <- tryCatch(
      sn::cp2dp(c(mu_rev, sd_rev, gamma_rev * s), family = "SN"),
      error = function(e) NULL
    )
    if (!is.null(dp_rev)) break
  }
  
  dp_exp <- NULL
  for (s in shrink) {
    dp_exp <- tryCatch(
      sn::cp2dp(c(mu_exp, sd_exp, gamma_exp * s), family = "SN"),
      error = function(e) NULL
    )
    if (!is.null(dp_exp)) break
  }
  
  # If dp construction fails, fall back to normal quantile mapping
  if (is.null(dp_rev)) {
    g_rev <- qnorm(u_rev, mean = mu_rev, sd = sd_rev)
  } else {
    g_rev <- sn::qsn(u_rev, dp = dp_rev)
  }
  
  if (is.null(dp_exp)) {
    g_exp <- qnorm(u_exp, mean = mu_exp, sd = sd_exp)
  } else {
    g_exp <- sn::qsn(u_exp, dp = dp_exp)
  }
  
  c(g_rev = g_rev, g_exp = g_exp)
}

# --- Growth engine ---
add_and_grow_rows <- function(df, vol_mult = 1.0) {
  
  hold_period <- 11
  
  expanded_df <- df %>%
    slice(rep(1, hold_period)) %>%
    mutate(year = NA_real_,
           revenue = NA_real_,
           expense = NA_real_,
           capex = NA_real_,
           random_growth_rev = NA_real_,
           random_growth_exp = NA_real_,
           random_capex = NA_real_,
           random_capspread = NA_real_,
           running_cap_rate = NA_real_)
  
  expanded_df$revenue[1] <- df$revenue[1]
  expanded_df$expense[1] <- df$expense[1]
  expanded_df$capex[1] <- df$capex[1]
  # --- FIX: start at going-in cap; spread state starts at 0; mean reverts to terminal spread ---
  expanded_df$capspread[1]        <- 0
  expanded_df$year[1]             <- df$year[1]
  expanded_df$running_cap_rate[1] <- df$caprate[1]   # going-in cap rate
  
  theta <- 0.25
  mu    <- df$capspread[1]        # long-run terminal spread over going-in cap
  
  
  sd_rev <- df$stdevrev[1] * vol_mult
  sd_exp <- df$stdevexpense[1] * vol_mult
  
  for (i in 2:hold_period) {
    
    # ============================================================
    # NEW (3): Use CAGR-consistent annual means
    # ============================================================
    growth_draws <- draw_correlated_growth(
      mu_rev   = df$drev_mu_adj[1],
      sd_rev   = sd_rev,
      skew_rev = df$skewrev[1],
      mu_exp   = df$dexp_mu_adj[1],
      sd_exp   = sd_exp,
      skew_exp = df$skewexpense[1],
      rho      = 0.70
    )
    
    g_rev <- pmax(as.numeric(growth_draws["g_rev"]), GROWTH_FLOOR)
    g_exp <- pmax(as.numeric(growth_draws["g_exp"]), GROWTH_FLOOR)
    
    expanded_df$random_growth_rev[i] <- g_rev
    expanded_df$random_growth_exp[i] <- g_exp
    
    expanded_df$revenue[i] <- expanded_df$revenue[i - 1] * (1 + g_rev)
    expanded_df$expense[i] <- expanded_df$expense[i - 1] * (1 + g_exp)
    
    expanded_df$random_capex[i] <- pmin(
      pmax(
        rsn_cp(1, df$capex[1], df$stdevcapex[1], df$skewcapex[1]),
        0
      ),
      1
    )
    expanded_df$capex[i] <- expanded_df$random_capex[i]
    
    rev_growth_to_date <- (expanded_df$revenue[i] / expanded_df$revenue[1])^(1/(i-1)) - 1
    growth_alpha <- rev_growth_to_date - df$drevenue[1]
    
    spread_shock <- rsn_cp(
      1, 0, df$stdevcapspread[1] * 0.5 * vol_mult, df$skewcapspread[1]
    )
    
    expanded_df$capspread[i] <- expanded_df$capspread[i - 1] +
      theta * (mu - expanded_df$capspread[i - 1]) -
      0.1 * growth_alpha +
      spread_shock
    
    expanded_df$random_capspread[i] <- expanded_df$capspread[i]
    expanded_df$running_cap_rate[i] <- df$caprate[1] + expanded_df$capspread[i]
    expanded_df$year[i] <- expanded_df$year[i - 1] + 1
  }
  
  expanded_df
}

# --- Run one simulation ---
run_simulation <- function(df, sim_id, proptype) {
  df_filtered <- df %>% filter(proptype == !!proptype)
  
  # ------------------------------------------------------------
  # ONE shared property-path simulation for BOTH equity and debt
  # ------------------------------------------------------------
  path_full <- add_and_grow_rows(df_filtered, vol_mult = 1.0) %>%
    mutate(proptype = proptype, simulation_id = sim_id)
  
  # ===== Equity IRR (same logic as before) =====
  y11_noi <- path_full$revenue[11] - path_full$expense[11]
  exit_cap <- max(0.03, path_full$running_cap_rate[10])   # keep your index convention [1](https://mydrive.metlife.com/personal/michael_steinberg_metlife_com/_layouts/15/Doc.aspx?sourcedoc=%7BD3BD71E5-89EB-4B89-931F-2D8193405FCF%7D&file=TESTDCF8_test5.xlsx&action=default&mobileredirect=true)
  
  terminal_floor <- 0.30 * df_filtered$value[1]
  end_val_raw <- y11_noi / exit_cap
  end_val <- pmax(end_val_raw, terminal_floor)
  
  # --- Build 10-year cashflows for IRR (Years 1..10) ---
  # --- Build 10-year operating cashflows (Years 1..10) ---
  dcf_10 <- path_full %>%
    dplyr::filter(row_number() <= 10) %>%
    dplyr::mutate(
      noi = revenue - expense,
      cf  = noi - (noi * capex),
      terminal_val_col = dplyr::if_else(row_number() == 10, end_val, 0),
      totalcf = cf + terminal_val_col   # IMPORTANT: do NOT embed purchase here
    )
  
  # ---- 10-year IRR uses explicit t=0 purchase (11 CFs => 10 periods) ----
  cf_vec <- c(
    -df_filtered$value[1],   # t=0 purchase
    dcf_10$cf[1:9],          # t=1..9 operating CF (Years 1..9)
    dcf_10$cf[10] + end_val  # t=10 operating CF + sale
  )
  irr_value <- irr_safe(cf_vec)
  
  # --- Return FULL 11-year path for calibration + attach CF cols for Years 1..10 ---
  expanded_data <- path_full %>%
    dplyr::left_join(
      dcf_10 %>% dplyr::select(year, noi, cf, terminal_val_col, totalcf),
      by = "year"
    ) %>%
    dplyr::mutate(IRR = irr_value)
  
  
  # ===== Debt metrics computed off the SAME path_full =====
  ltv    <- df_filtered$ltv[1]
  spread <- df_filtered$spread[1]          # already decimal after join [1](https://mydrive.metlife.com/personal/michael_steinberg_metlife_com/_layouts/15/Doc.aspx?sourcedoc=%7BD3BD71E5-89EB-4B89-931F-2D8193405FCF%7D&file=TESTDCF8_test5.xlsx&action=default&mobileredirect=true)
  
  loan_amt <- ltv * df_filtered$value[1]
  
  # Optional coupon / interest (kept if you want to store later)
  coupon <- BASE_SOFR + spread
  
  # Exit value at maturity (MATCH equity logic exactly, but using same path_full)
  s_exit_v_raw <- (path_full$revenue[11] - path_full$expense[11]) /
    max(0.03, path_full$running_cap_rate[10])
  
  debt_terminal_floor <- 0.30 * df_filtered$value[1]
  s_exit_v <- pmax(s_exit_v_raw, debt_terminal_floor)
  
  recovery_val <- s_exit_v * 0.95
  is_default <- as.integer(loan_amt > recovery_val)
  
  loss_sev <- if_else(
    is_default == 1,
    (loan_amt - recovery_val) / loan_amt,
    0
  )
  
  debt_metrics <- tibble(
    simulation_id = sim_id,
    proptype = proptype,
    spread_bps = df_filtered$spread_bps[1],
    is_default = is_default,
    loss_sev = loss_sev
  )
  
  return(list(
    irr_data = tibble(simulation_id = sim_id, proptype = proptype, IRR = irr_value),
    expanded_data = expanded_data,
    debt_data = debt_metrics
  ))
}

run_base_case_dcf <- function(df, proptype) {
  
  df_filtered <- df %>% filter(proptype == !!proptype)
  
  #dcf <- add_base_case_rows(df_filtered)
  
  #y11_noi <- dcf$revenue[11] - dcf$expense[11]
  #exit_cap <- max(0.03, dcf$running_cap_rate[10])
  
  #terminal_floor <- 0.30 * df_filtered$value[1]
  #end_val <- pmax(y11_noi / exit_cap, terminal_floor)
  
  dcf_full <- add_base_case_rows(df_filtered)   # 11 rows (Years 1..11)
  
  y11_noi <- dcf_full$revenue[11] - dcf_full$expense[11]
  exit_cap <- max(0.03, dcf_full$running_cap_rate[10])
  
  terminal_floor <- 0.30 * df_filtered$value[1]
  end_val <- pmax(y11_noi / exit_cap, terminal_floor)
  
  # Years 1..10 cashflows (sale at Year 10)
  dcf_10 <- dcf_full %>%
    dplyr::filter(row_number() <= 10) %>%
    dplyr::mutate(
      noi = revenue - expense,
      cf  = noi - (noi * capex),
      terminal_val_col = dplyr::if_else(row_number() == 10, end_val, 0),
      totalcf = cf + terminal_val_col
    )
  
  # 10-year IRR (explicit t=0 purchase)
  cf_vec <- c(
    -df_filtered$value[1],
    dcf_10$cf[1:9],
    dcf_10$cf[10] + end_val
  )
  irr_value <- irr_safe(cf_vec)
  
  # Return full 11-year base-case table, attach CF cols for Years 1..10
  dcf <- dcf_full %>%
    dplyr::left_join(
      dcf_10 %>% dplyr::select(year, noi, cf, terminal_val_col, totalcf),
      by = "year"
    ) %>%
    dplyr::mutate(IRR = irr_value, proptype = proptype)
  
  dcf
  
}

run_base_case_loan <- function(df, proptype) {
  
  df_filtered <- df %>% filter(proptype == !!proptype)
  
  # Reuse base case cash flow paths
  dcf <- add_base_case_rows(df_filtered)
  
  # Loan terms
  loan_amt <- df_filtered$ltv[1] * df_filtered$value[1]
  coupon <- BASE_SOFR + df_filtered$spread[1]
  annual_int <- loan_amt * coupon
  
  # Compute loan metrics
  loan_tbl <- dcf %>%
    mutate(
      noi = revenue - expense,
      annual_interest = annual_int,
      DSCR = noi / annual_interest,
      Debt_Yield = noi / loan_amt,
      implied_value = noi / running_cap_rate,
      LTV = loan_amt / implied_value
    )
  
  # Exit metrics
  y11_noi <- dcf$revenue[11] - dcf$expense[11]
  exit_cap <- max(0.03, dcf$running_cap_rate[10])
  exit_value <- max(y11_noi / exit_cap, 0.30 * df_filtered$value[1])
  
  loan_tbl %>%
    slice(1:10) %>%
    mutate(
      Exit_Value = if_else(row_number() == 10, exit_value, NA_real_),
      Exit_LTV = if_else(row_number() == 10, loan_amt / exit_value, NA_real_)
    )
}


base_case_loans <- map_dfr(property_types, ~
                             run_base_case_loan(data, .x) %>% mutate(proptype = .x)
)


# --- RUN SIMULATIONS ---
num_simulations <- simct

simulation_results <- future_map(property_types, function(ptype) {
  future_map(1:num_simulations, ~ run_simulation(data, .x, ptype), .options = furrr_options(seed = TRUE))
}, .options = furrr_options(seed = TRUE)) %>% flatten()

irr_results <- map_dfr(simulation_results, "irr_data")
random_variables <- map_dfr(simulation_results, "expanded_data")
debt_raw <- map_dfr(simulation_results, "debt_data")


# --- LOG-SPACE CALIBRATION CHECK (diagnostic) ---

log_realized_tbl <- random_variables %>%
  filter(year == min(year) | year > min(year)) %>%  # no-op; keeps structure
  arrange(proptype, simulation_id, year) %>%
  group_by(proptype, simulation_id) %>%
  summarize(
    mean_log_rev = mean(log1p(random_growth_rev[year > min(year)]), na.rm = TRUE),
    mean_log_exp = mean(log1p(random_growth_exp[year > min(year)]), na.rm = TRUE),
    .groups = "drop"
  ) %>%
  group_by(proptype) %>%
  summarize(
    realized_log_rev = mean(mean_log_rev, na.rm = TRUE),
    realized_log_exp = mean(mean_log_exp, na.rm = TRUE),
    .groups = "drop"
  )

log_targets <- data %>%
  dplyr::group_by(proptype) %>%
  dplyr::summarize(
    target_log_rev = log1p(dplyr::first(drevenue)),
    target_log_exp = log1p(dplyr::first(dexpense)),
    .groups = "drop"
  )

log_check <- log_targets %>%
  dplyr::left_join(log_realized_tbl, by = "proptype") %>%
  dplyr::mutate(
    rev_log_diff_bps = (realized_log_rev - target_log_rev) * 10000,
    exp_log_diff_bps = (realized_log_exp - target_log_exp) * 10000
  ) %>%
  dplyr::arrange(desc(rev_log_diff_bps))

print(log_check)


corr_check <- random_variables %>%
  dplyr::filter(!is.na(random_growth_rev), !is.na(random_growth_exp)) %>%
  dplyr::group_by(proptype) %>%
  dplyr::summarize(
    corr_rev_exp = cor(random_growth_rev, random_growth_exp, use = "complete.obs"),
    n_obs = dplyr::n(),
    .groups = "drop"
  ) %>%
  dplyr::arrange(desc(corr_rev_exp))

print(corr_check)


check_skew <- random_variables %>%
  filter(!is.na(random_growth_rev)) %>%
  group_by(proptype) %>%
  summarize(
    sample_skew_rev = moments::skewness(random_growth_rev, na.rm=TRUE),
    sample_skew_exp = moments::skewness(random_growth_exp, na.rm=TRUE),
    .groups="drop"
  )

print(check_skew)
      

# --- RISK METRICS ---
calculate_ratios <- function(irr_values, risk_free_rate = 0.0425, mar = .07) {
  mean_irr <- mean(irr_values, na.rm = TRUE)
  sd_irr <- sd(irr_values, na.rm = TRUE)
  downside_deviation <- sd(pmax(0, mar - irr_values), na.rm = TRUE)
  sharpe_ratio <- (mean_irr - risk_free_rate) / sd_irr
  sortino_ratio <- (mean_irr - mar) / downside_deviation
  return(list(sharpe_ratio = sharpe_ratio, sortino_ratio = sortino_ratio))
}

summary_results <- irr_results %>%
  group_by(proptype) %>%
  summarize(mean_IRR = mean(IRR, na.rm = TRUE), sd_IRR = sd(IRR, na.rm = TRUE),
            min_IRR = min(IRR, na.rm = TRUE), max_IRR = max(IRR, na.rm = TRUE),
            sharpe_ratio = calculate_ratios(IRR)$sharpe_ratio,
            sortino_ratio = calculate_ratios(IRR)$sortino_ratio, .groups = "drop")

# --- Inputs vs realized calibration check ---
inputs_tbl <- data %>%
  group_by(proptype) %>%
  summarize(
    input_drev = first(drevenue),
    input_dexp = first(dexpense),
    input_capex = first(capex),
    input_caprate = first(caprate),
    input_capspread = first(capspread),
    input_sd_rev = first(stdevrev),
    input_sd_exp = first(stdevexpense),
    input_sd_capex = first(stdevcapex),
    input_sd_capspread = first(stdevcapspread),
    .groups = "drop"
  )

realized_tbl <- random_variables %>%
  group_by(proptype, simulation_id) %>%
  summarize(
    rev_cagr_10y = (revenue[11] / revenue[1])^(1/10) - 1,
    exp_cagr_10y = (expense[11] / expense[1])^(1/10) - 1,
    avg_capex = mean(capex[2:10], na.rm = TRUE),
    start_cap = first(running_cap_rate),
    exit_cap = running_cap_rate[10],
    .groups = "drop"
  ) %>%
  group_by(proptype) %>%
  summarize(
    realized_rev_cagr = mean(rev_cagr_10y, na.rm = TRUE),
    realized_exp_cagr = mean(exp_cagr_10y, na.rm = TRUE),
    realized_capex = mean(avg_capex, na.rm = TRUE),
    realized_start_cap = mean(start_cap, na.rm = TRUE),
    realized_exit_cap = mean(exit_cap, na.rm = TRUE),
    .groups = "drop"
  )

calibration_table <- inputs_tbl %>%
  left_join(realized_tbl, by = "proptype") %>%
  mutate(
    rev_cagr_diff = realized_rev_cagr - input_drev,
    exp_cagr_diff = realized_exp_cagr - input_dexp,
    capex_diff = realized_capex - input_capex,
    exit_cap_diff = realized_exit_cap - (input_caprate + input_capspread)
  )

debt_summary <- debt_raw %>%
  group_by(proptype) %>%
  summarize(
    Spread_bps = first(spread_bps),
    PD = mean(is_default),
    Avg_LGD = if_else(sum(is_default) > 0, sum(loss_sev) / sum(is_default), 0),
    Total_EL = PD * Avg_LGD,
    Ann_EL = Total_EL / 10,
    Ann_EL_bps = Ann_EL * 10000,
    Loss_Adjusted_Spread_bps = Spread_bps - (Ann_EL * 10000),
    .groups = "drop"
  ) %>%
  rowwise() %>%
  mutate(Rating = get_moodys_rating(Ann_EL)) %>%
  ungroup()

base_case_dcfs <- map_dfr(property_types, ~ run_base_case_dcf(data, .x))


# --- SHINY APP ---
ui <- fluidPage(
  theme = shinytheme("flatly"),
  tags$head(
    tags$style(HTML("
      .metric-box { text-align: center; padding: 10px; }
      .metric-title { font-weight: bold; font-size: 0.9em; color: #7f8c8d; }
      .metric-value { font-size: 1.2em; font-weight: bold; color: #2c3e50; }
    "))
  ),
  titlePanel("MIM Stochastic Real Estate Model"),
  tabsetPanel(
    tabPanel("Dashboard Summary",
             br(),
             fluidRow(
               column(4, selectInput("proptype", "Select Property Type:", choices = unique(irr_results$proptype))),
               column(4, selectInput("variable", "Select Variable:",
                                     choices = c("random_growth_rev", "random_growth_exp", "random_capex", "random_capspread", "running_cap_rate")))
             ),
             fluidRow(column(12, h3("Summary Table"), DTOutput("summaryTable"))),
             fluidRow(
               column(6, h3("IRR Distribution"), plotOutput("irrPlot")),
               column(6, h3("Random Variable Analysis"), plotOutput("variablePlot"))
             )
    ),
    tabPanel("Calibration (Inputs vs Realized)",
             br(),
             h3("Calibration Table"),
             p("Compares key input assumptions vs realized averages across simulations."),
             DTOutput("calibrationTable")
    ),
    tabPanel("Credit Analysis",
             br(),
             h3("Debt Summary Output"),
             p("Debt logic: LTV from survey, 5% Liquidation Haircut."),
             DTOutput("debtTable")),
    tabPanel("Base Case DCF",
             br(),
             fluidRow(
               column(4, selectInput(
                 "base_proptype",
                 "Select Property Type:",
                 choices = unique(base_case_dcfs$proptype)
               )),
               column(8, wellPanel(
                 h4("Base Case Summary", style = "text-align:center;"),
                 uiOutput("base_case_stats")
               ))
             ),
             hr(),
             h3("Base Case Cash Flow Projection"),
             DTOutput("base_case_table")
    ),
    tabPanel("Base Case Loan",
             br(),
             fluidRow(
               column(4, selectInput(
                 "loan_proptype",
                 "Select Property Type:",
                 choices = unique(base_case_loans$proptype)
               ))
             ),
             hr(),
             h3("Base Case Loan Pro Forma"),
             DTOutput("base_case_loan_table")
    ),
    tabPanel("Review Individual DCFs",
             br(),
             fluidRow(
               column(3, selectInput("detail_proptype", "Filter Property Type:", choices = unique(irr_results$proptype))),
               column(3, selectInput("sim_id", "Select Simulation ID:", choices = NULL)),
               column(6, wellPanel(
                 h4("Simulation Summary", style = "text-align: center; border-bottom: 1px solid #ddd; padding-bottom: 5px;"),
                 uiOutput("sim_quick_stats")
               ))
             ),
             hr(),
             h3("Diagnostic Cash Flow Projection"),
             DTOutput("dcfDetailTable")
    )
  )
)

server <- function(input, output, session) {
  
  options(shiny.error = browser)
  
  output$base_case_table <- renderDT({
    req(input$base_proptype)
    
    # Pull full base-case path for selected proptype (should be 11 rows: years 1..11)
    d0 <- base_case_dcfs %>%
      dplyr::filter(proptype == input$base_proptype) %>%
      dplyr::arrange(year)
    
    # Keep ONLY operating years for the displayed 10-year DCF (years 1..10)
    d_ops <- d0 %>%
      dplyr::slice(1:11) %>%   # <-- include forward NOI row (Year 11)
      dplyr::mutate(
        noi = if ("noi" %in% names(.)) dplyr::coalesce(.data$noi, revenue - expense) else (revenue - expense),
        t   = dplyr::row_number(),   # t = 1..11
        row_type = dplyr::case_when(
          t <= 10 ~ "Operating (CF year)",
          t == 11 ~ "Forward NOI (valuation only)"
        ),
        # Forward row should not be treated as a cashflow year
        totalcf = dplyr::if_else(t == 11, NA_real_, as.numeric(.data$totalcf))
      ) %>%
      dplyr::transmute(
        t, year, row_type,
        revenue = as.numeric(revenue),
        expense = as.numeric(expense),
        noi     = as.numeric(noi),
        capex   = as.numeric(capex),
        capspread = as.numeric(capspread),
        running_cap_rate = as.numeric(running_cap_rate),
        totalcf = as.numeric(totalcf)
      )
    
    # Add explicit purchase row at t=0 (matches your 10-year IRR cashflow vector logic)
    purchase_value <- data %>%
      dplyr::filter(proptype == input$base_proptype) %>%
      dplyr::slice(1) %>%
      dplyr::pull(value)
    
    purchase_row <- tibble::tibble(
      t = 0,
      year = d_ops$year[1] - 1,
      revenue = NA_real_,
      expense = NA_real_,
      noi = NA_real_,
      capex = NA_real_,
      capspread = NA_real_,
      running_cap_rate = NA_real_,
      totalcf = -as.numeric(purchase_value)
    )
    
    d <- dplyr::bind_rows(purchase_row, d_ops) %>%
      dplyr::arrange(t)
    
    DT::datatable(
      d,
      options = list(
        pageLength = 12,
        dom = "t",
        columnDefs = list(list(className = "dt-center", targets = "_all"))
      )
    ) %>%
      DT::formatCurrency(c("revenue", "expense", "noi", "totalcf"), "$") %>%
      DT::formatPercentage(c("capex", "capspread", "running_cap_rate"), 2)
  })
  
  
  
  output$base_case_loan_table <- renderDT({
    req(input$loan_proptype)
    
    d <- base_case_loans %>%
      filter(proptype == input$loan_proptype) %>%
      dplyr::select(
        year, noi, annual_interest, DSCR, Debt_Yield,
        running_cap_rate, LTV, Exit_Value, Exit_LTV
      )
    
    datatable(d, options = list(
      pageLength = 11,
      dom = "t",
      columnDefs = list(
        list(className = "dt-center", targets = "_all")
      )
    )) %>%
      formatCurrency(c("noi", "annual_interest", "Exit_Value"), "$") %>%
      formatPercentage(
        c("Debt_Yield", "running_cap_rate", "LTV", "Exit_LTV"),
        2
      ) %>%
      formatRound("DSCR", 2)
  })
  
  
  output$base_case_stats <- renderUI({
    req(input$base_proptype)
    
    d <- base_case_dcfs %>%
      filter(proptype == input$base_proptype)
    
    avg_rev_growth <- (d$revenue[11] / d$revenue[1])^(1/10) - 1
    avg_exp_growth <- (d$expense[11] / d$expense[1])^(1/10) - 1
    avg_capex_noi  <- mean(d$capex[2:10], na.rm = TRUE)
    
    start_noi <- d$revenue[1] - d$expense[1]
    start_cap_underwriting <- start_noi / 100
    
    tagList(
      fluidRow(
        column(6, div(class = "metric-box",
                      div(class = "metric-title", "Base Case IRR"),
                      div(class = "metric-value", percent(first(d$IRR), accuracy = 0.01))
        )),
        column(6, div(class = "metric-box",
                      # Underwriting starting cap rate = Year-1 NOI / Value
                      div(class = "metric-title", "Starting Cap Rate (NOI / Value)"),
                      div(class = "metric-value", percent(start_cap_underwriting, accuracy = 0.01))
        ))
      ),
      fluidRow(
        column(6, div(class = "metric-box",
                      div(class = "metric-title", "Exit Cap Rate"),
                      div(class = "metric-value", percent(d$running_cap_rate[10], accuracy = 0.01))
        )),
        column(6, div(class = "metric-box",
                      div(class = "metric-title", "10yr Avg Rev Growth"),
                      div(class = "metric-value", percent(avg_rev_growth, accuracy = 0.01))
        ))
      ),
      fluidRow(
        column(6, div(class = "metric-box",
                      div(class = "metric-title", "10yr Avg Exp Growth"),
                      div(class = "metric-value", percent(avg_exp_growth, accuracy = 0.01))
        )),
        column(6, div(class = "metric-box",
                      div(class = "metric-title", "Avg CapEx (yrs 2–10)"),
                      div(class = "metric-value", percent(avg_capex_noi, accuracy = 0.01))
        ))
      )
    )
  })
  
  
  observeEvent(input$detail_proptype, {
    sims <- irr_results %>%
      filter(proptype == input$detail_proptype) %>%
      pull(simulation_id) %>% unique() %>% sort()
    updateSelectInput(session, "sim_id", choices = sims)
  })
  
  output$irrPlot <- renderPlot({
    irr_results %>%
      filter(proptype == input$proptype) %>%
      ggplot(aes(x = IRR)) +
      geom_density(fill = "blue", alpha = 0.5) +
      scale_x_continuous(labels = percent_format(accuracy = 0.1)) +
      theme_minimal()
  })
  
  output$summaryTable <- renderDT({
    datatable(summary_results) %>% formatPercentage(2:5, 3) %>% formatRound(6:7, 3)
  })
  
  output$calibrationTable <- renderDT({
    datatable(calibration_table) %>%
      formatPercentage(
        columns = c("input_drev","realized_rev_cagr","rev_cagr_diff",
                    "input_dexp","realized_exp_cagr","exp_cagr_diff",
                    "input_capex","realized_capex","capex_diff",
                    "input_caprate","realized_start_cap",
                    "realized_exit_cap","exit_cap_diff"),
        digits = 2
      ) %>%
      formatRound(
        columns = c("input_sd_rev","input_sd_exp","input_sd_capex","input_sd_capspread"),
        digits = 3
      )
  })
  
  output$debtTable <- renderDT({
    datatable(
      debt_summary,
      options = list(
        pageLength = 10,
        dom = "lrtip",   # length, filter, table, info, pagination
        lengthMenu = c(10, 25, 50, 100),
        columnDefs = list(
          list(className = "dt-center", targets = "_all")
        )
      )
    ) %>%
      formatRound(
        columns = c("Spread_bps", "Ann_EL_bps", "Loss_Adjusted_Spread_bps"),
        digits = 1
      ) %>%
      formatPercentage(
        columns = c("PD", "Avg_LGD", "Total_EL", "Ann_EL"),
        digits = 3
      ) %>%
      formatStyle(
        'Rating',
        backgroundColor = styleEqual(
          c("Aaa", "Aa", "A", "Baa"),
          c("#d4edda", "#d1ecf1", "#fff3cd", "#f8d7da")
        )
      ) %>%
      formatStyle(
        'Loss_Adjusted_Spread_bps',
        color = styleInterval(
          0,
          c("red", "black")
        )
      )
  })
  
  output$variablePlot <- renderPlot({
    v_data <- random_variables %>%
      filter(proptype == input$proptype) %>%
      pull(input$variable)
    ggplot(data.frame(v_data), aes(x = v_data)) +
      geom_histogram(bins = 30, fill = "blue", alpha = 0.5) +
      theme_minimal()
  })
  
  output$sim_quick_stats <- renderUI({
    req(input$sim_id, input$detail_proptype)
    d <- random_variables %>%
      filter(proptype == input$detail_proptype, simulation_id == input$sim_id)
    
    avg_rev_growth <- (d$revenue[11] / d$revenue[1])^(1/10) - 1
    avg_exp_growth <- (d$expense[11] / d$expense[1])^(1/10) - 1
    avg_capex_noi <- mean(d$capex[2:10], na.rm = TRUE)
    
    tagList(
      fluidRow(
        column(6, div(class = "metric-box",
                      div(class = "metric-title", "Model IRR"),
                      div(class = "metric-value", percent(d$IRR[1], accuracy = 0.01)))),
        column(6, div(class = "metric-box",
                      div(class = "metric-title", "Starting Cap Rate"),
                      div(class = "metric-value", percent(d$running_cap_rate[1], accuracy = 0.01))))
      ),
      fluidRow(
        column(6, div(class = "metric-box",
                      div(class = "metric-title", "Exit Cap Rate"),
                      div(class = "metric-value", percent(d$running_cap_rate[10], accuracy = 0.01)))),
        column(6, div(class = "metric-box",
                      div(class = "metric-title", "10yr Avg Rev Growth"),
                      div(class = "metric-value", percent(avg_rev_growth, accuracy = 0.01))))
      ),
      fluidRow(
        column(6, div(class = "metric-box",
                      div(class = "metric-title", "10yr Avg Exp Growth"),
                      div(class = "metric-value", percent(avg_exp_growth, accuracy = 0.01)))),
        column(6, div(class = "metric-box",
                      div(class = "metric-title", "Avg CapEx (years 2-10)"),
                      div(class = "metric-value", percent(avg_capex_noi, accuracy = 0.01))))
      )
    )
  })
  
  output$dcfDetailTable <- renderDT({
    req(input$sim_id, input$detail_proptype)
    
    # Pull the selected simulation path
    d0 <- random_variables %>%
      dplyr::filter(
        proptype == input$detail_proptype,
        simulation_id == input$sim_id
      ) %>%
      dplyr::arrange(year)
    
    # Keep ONLY operating years for the displayed 10-year DCF (years 1..10)
    d_ops <- d0 %>%
      dplyr::slice(1:11) %>%
      dplyr::mutate(
        noi = if ("noi" %in% names(.)) dplyr::coalesce(.data$noi, revenue - expense) else (revenue - expense),
        totalcf = if ("totalcf" %in% names(.)) .data$totalcf else NA_real_,
        t = dplyr::row_number(),
        row_type = dplyr::if_else(t == 11, "Forward NOI (valuation only)", "Operating (CF year)"),
        totalcf = dplyr::if_else(t == 11, NA_real_, as.numeric(totalcf))
      ) %>%
      dplyr::transmute(
        t, year, row_type,
        revenue = as.numeric(revenue),
        random_growth_rev = if ("random_growth_rev" %in% names(.)) as.numeric(.data$random_growth_rev) else NA_real_,
        expense = as.numeric(expense),
        random_growth_exp = if ("random_growth_exp" %in% names(.)) as.numeric(.data$random_growth_exp) else NA_real_,
        running_cap_rate  = as.numeric(running_cap_rate),
        noi     = as.numeric(noi),
        totalcf = as.numeric(totalcf)
      )
    
    # Purchase row at t=0 (matches your IRR cashflow vector)
    purchase_value <- data %>%
      dplyr::filter(proptype == input$detail_proptype) %>%
      dplyr::slice(1) %>%
      dplyr::pull(value)
    
    purchase_row <- tibble::tibble(
      t = 0,
      year = d_ops$year[1] - 1,
      revenue = NA_real_,
      random_growth_rev = NA_real_,
      expense = NA_real_,
      random_growth_exp = NA_real_,
      running_cap_rate = NA_real_,
      noi = NA_real_,
      totalcf = -as.numeric(purchase_value)
    )
    
    d <- dplyr::bind_rows(purchase_row, d_ops) %>%
      dplyr::arrange(t)
    
    # Only format columns that exist (prevents DT JS errors)
    currency_cols <- intersect(c("revenue", "expense", "noi", "totalcf"), names(d))
    pct_cols      <- intersect(c("random_growth_rev", "random_growth_exp", "running_cap_rate"), names(d))
    
    DT::datatable(
      d,
      options = list(
        pageLength = 12,
        dom = "t",
        columnDefs = list(list(className = "dt-center", targets = "_all"))
      )
    ) %>%
      DT::formatCurrency(currency_cols, "$") %>%
      DT::formatPercentage(pct_cols, 2)
  })
  
}

plan(sequential)
gc()
shinyApp(ui = ui, server = server)

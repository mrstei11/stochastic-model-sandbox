# =============================================================================
# MIM Stochastic Real Estate Model  –  Python / Dash port of sm26.R
#
# Key optimisations vs. the R version
#   • All N simulations drawn at once with NumPy (no Python-level for-loops
#     over simulations).
#   • Jensen / CAGR correction uses a fixed-seed MC approach identical to R
#     but vectorised with scipy.optimize.brentq.
#   • Gaussian-copula correlated draws computed in one MASS::mvrnorm-equivalent
#     call (np.random.multivariate_normal).
#   • Skew-normal via scipy.stats.skewnorm – parameter mapping mirrors sn::cp2dp.
#   • Dash + Plotly for the interactive dashboard.
# =============================================================================

import os
import warnings
import numpy as np
import pandas as pd
from scipy import stats
from scipy.optimize import brentq
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import uvicorn

warnings.filterwarnings("ignore")

# ---------------------------------------------------------------------------
# Paths  –  resolve relative to this script so it works from any CWD
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))

# Load filenames from config.json so you can swap input files without editing code
import json as _json
_cfg_path = os.path.join(HERE, "config.json")
with open(_cfg_path, encoding="utf-8") as _f:
    _cfg = _json.load(_f)
DATA_PATH = os.path.join(HERE, _cfg["data_file"])
DEBT_PATH = os.path.join(HERE, _cfg["debt_file"])
print(f"  Data file : {os.path.basename(DATA_PATH)}")
print(f"  Debt file : {os.path.basename(DEBT_PATH)}")

# ---------------------------------------------------------------------------
# Global constants
# ---------------------------------------------------------------------------
SIM_COUNT    = 10_000
HOLD_PERIOD  = 11       # years 1-11 (sale at end of year 10, forward NOI year 11)
BASE_SOFR    = 0.0363
GROWTH_FLOOR        = -0.95
THETA               = 0.25     # mean-reversion speed for cap-rate spread
REV_MEAN_REVERSION  = 0.25     # revenue level reversion to trend (OU in logs);
                               # 0 = permanent shocks (random walk), half-life ≈ ln2/κ ≈ 2.4 yrs
EXP_MEAN_REVERSION  = 0.10     # gentler than revenue: costs are sticky — they
                               # track the inflation trend but adjust slower
                               # than revenue recovers (κ=0.25 proved so strong
                               # it erased the vol-driven credit differentiation)
RHO                 = 0.70     # revenue/expense growth correlation
RISK_FREE           = 0.0425
MAR                 = 0.07     # minimum acceptable return for Sortino
TERMINAL_REV_GROWTH = 0.03     # revenue growth rate pinned for final years
TERMINAL_REV_SD     = 0.005    # tight noise on terminal years (±~1% at 2σ)
N_TERMINAL_REV      = 4        # number of terminal (late) years
MAX_ABS_SKEW = 0.3
SHRINK_STEPS = [1, 0.85, 0.70, 0.55, 0.40, 0.25, 0.10, 0.0]

# CMM-style logistic EDF coefficients (term-default leg; maturity default is
# a separate deterministic LTV test — see CREDIT_PARAMS).
# Recalibrated (2026-07) against historical CMBS/life-co loss anchors
# (Fitch conduit 1993-2002, KBRA SASB 1993-2024, Moody's severities, NAIC CM
# factors) so cross-sector annual EL spans ~6 bps (stabilized housing/net
# lease) to ~70 bps (full-service hotels); see calibrate_credit.py for the
# sweep used to pick these.
EDF_A0 = -6.50   # intercept (baseline: DSCR=1.5, LTV=0.60)
EDF_A1 =  1.50   # distress coefficient: max(0, 1.5 - DSCR)
EDF_A2 = -1.31   # safety coefficient:   max(0, DSCR - 1.5)
EDF_A3 =  1.00   # LTV pressure:         (LTV_t - 0.60)

# CMM Structural LGD carry costs (Table 15 Liquidation Expense Worksheet)
LGD_ONGOING_PER_YR = 0.057  # 5.7%/yr: servicing 1.5% + legal 1.0% + maint 2.0% + tax/ins 1.2%
LGD_ONETIME        = 0.055  # 5.5% one-time: broker commission 3.0% + renovation 2.5%
# Time-to-resolution by property type (years); from CMM empirical workout data
T_RESOLVE         = {"Hotel": 1.5, "Office": 2.5}
T_RESOLVE_DEFAULT = 2.0
# Property-type LGD severity scalars (CMM Table 12: office actual 37%, hotel actual 16%)
LGD_SCALAR         = {"Office": 1.40, "Hotel": 0.70}
LGD_SCALAR_DEFAULT = 1.00

def cmm_class(proptype: str) -> str:
    """Map full sector names (e.g. "Full-Service Hotels") to the CMM property
    classes used as keys in T_RESOLVE / LGD_SCALAR. Traditional office only —
    Medical Office and Life Science are not CMM "Office"."""
    if "Hotel" in proptype:
        return "Hotel"
    if proptype.startswith("Office"):
        return "Office"
    return "Other"

# ---------------------------------------------------------------------------
# 1.  DATA LOADING
# ---------------------------------------------------------------------------
import shutil as _shutil, tempfile as _tempfile

def _safe_read_excel(path):
    """Copy to a temp file first so we can read even if Excel has it open."""
    try:
        return pd.read_excel(path)
    except PermissionError:
        tmp = _tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False)
        tmp.close()
        _shutil.copy2(path, tmp.name)
        df = pd.read_excel(tmp.name)
        os.unlink(tmp.name)
        return df

def load_data() -> pd.DataFrame:
    data = _safe_read_excel(DATA_PATH)
    debt = (
        _safe_read_excel(DEBT_PATH)
        .rename(columns={"Sector": "proptype", "Spread": "spread_bps",
                          "LTV": "ltv", "Debt Yield": "debt_yield"})
    )
    debt["spread"] = debt["spread_bps"] / 10_000
    return data.merge(debt, on="proptype", how="left")


# ---------------------------------------------------------------------------
# 2.  SKEW-NORMAL HELPERS
#     scipy skewnorm uses the "alpha-parameterisation" (location ξ, scale ω,
#     shape α).  We expose a "central-params" interface (mean, sd, skew γ₁)
#     matching the R sn::cp2dp interface, with the same shrink-fallback logic.
# ---------------------------------------------------------------------------
def _cp_to_alpha_params(mean: float, sd: float, gamma1: float):
    """
    Convert central-params (μ_cp, σ_cp, γ₁) → scipy skewnorm (loc, scale, a).
    Returns None if |γ₁| ≥ 0.9953 (distribution boundary).
    """
    # δ from skewness: γ₁ = (4-π)/2 · (δ√(2/π))³ / (1 - 2δ²/π)^(3/2)
    # We solve numerically via the known closed-form inversion:
    #   c  = (2|γ₁|/( (4-π) ))^(1/3)     (sgn applied below)
    #   δ² = π/2 · c² / (1 + c²)
    if abs(gamma1) < 1e-10:
        return 0.0, mean, sd          # a, loc, scale  (normal)
    sign = np.sign(gamma1)
    abs_g = abs(gamma1)
    # boundary: max |γ₁| for SN is (4-π)/2*(√(2/π))³ ≈ 0.9953 ... clamp
    abs_g = min(abs_g, 0.99)
    c3    = (2 * abs_g / (4 - np.pi))
    c     = c3 ** (1.0 / 3.0)
    delta2 = (np.pi / 2) * c**2 / (1 + c**2)
    delta  = sign * np.sqrt(delta2)
    alpha  = delta / np.sqrt(1 - delta2)
    b      = np.sqrt(2 / np.pi) * delta
    mu_z   = b
    sigma_z = np.sqrt(1 - b**2)
    # cp → dp transform
    loc    = mean  - sd * (mu_z / sigma_z)
    scale  = sd / sigma_z
    return alpha, loc, scale


def skewnorm_rvs_cp(n: int, mean: float, sd: float, dial: float,
                    rng: np.random.Generator) -> np.ndarray:
    """Draw n samples from skew-normal defined by central params, with shrink fallback.
    dial is the alpha (shape) parameter of scipy skewnorm — same interpretation as
    R's sn package.  dial=0 → standard normal; large |dial| → near-max skew.
    """
    if not np.isfinite(mean) or not np.isfinite(sd) or sd <= 0:
        return rng.normal(mean if np.isfinite(mean) else 0.0,
                          sd   if (np.isfinite(sd) and sd > 0) else 1.0, n)
    # Convert alpha → gamma1, then to loc/scale via cp2dp
    # For large |alpha|, gamma1 saturates near ±0.9953; tanh maps to full range
    gamma1 = -0.9953 * np.tanh(np.clip(dial, -30, 30) / 10)
    for s in SHRINK_STEPS:
        try:
            a, loc, scale = _cp_to_alpha_params(mean, sd, gamma1 * s)
            return stats.skewnorm.rvs(a, loc=loc, scale=scale, size=n, random_state=rng)
        except Exception:
            continue
    return rng.normal(mean, sd, n)


def skewnorm_ppf_cp(u: np.ndarray, mean: float, sd: float, dial: float) -> np.ndarray:
    """Percent-point function (quantile) for skew-normal in central params."""
    gamma1 = -0.9953 * np.tanh(np.clip(dial, -30, 30) / 10)
    for s in SHRINK_STEPS:
        try:
            a, loc, scale = _cp_to_alpha_params(mean, sd, gamma1 * s)
            return stats.skewnorm.ppf(u, a, loc=loc, scale=scale)
        except Exception:
            continue
    return stats.norm.ppf(u, loc=mean, scale=sd)


# ---------------------------------------------------------------------------
# 3.  CAGR-CONSISTENT MEAN SOLVER  (Jensen correction)
# ---------------------------------------------------------------------------
def solve_mu_for_target_cagr(target_cagr: float, sd: float, dial: float,
                              n_mc: int = 100_000, seed: int = 123) -> float:
    """
    Find annual mean μ such that E[log(1+g)] = log(1+target_cagr),
    where g ~ SN(μ, sd, dial) clamped at GROWTH_FLOOR.
    """
    if not np.isfinite(target_cagr) or not np.isfinite(sd) or sd <= 0:
        return target_cagr

    target_log = np.log1p(target_cagr)
    rng = np.random.default_rng(seed)
    # Draw zero-mean shocks once (fixed)
    eps = skewnorm_rvs_cp(n_mc, 0.0, sd, dial, rng)
    bad = ~np.isfinite(eps)
    if bad.any():
        eps[bad] = rng.normal(0, sd, bad.sum())

    def f(mu):
        g   = np.maximum(eps + mu, GROWTH_FLOOR)
        val = np.mean(np.log1p(g)) - target_log
        return val if np.isfinite(val) else (1e6 if mu > target_cagr else -1e6)

    lo = max(GROWTH_FLOOR + 1e-6, target_cagr - 20 * sd)
    hi = target_cagr + 20 * sd
    f_lo, f_hi = f(lo), f(hi)

    if not (np.isfinite(f_lo) and np.isfinite(f_hi)):
        return target_cagr
    if np.sign(f_lo) == np.sign(f_hi):
        lo, hi = max(GROWTH_FLOOR + 1e-6, target_cagr - 30 * sd), target_cagr + 30 * sd
        f_lo, f_hi = f(lo), f(hi)
        if np.sign(f_lo) == np.sign(f_hi):
            return target_cagr
    try:
        return brentq(f, lo, hi, xtol=1e-7)
    except Exception:
        return target_cagr


def precompute_mu_adjustments(data: pd.DataFrame) -> pd.DataFrame:
    rows = []
    n_total    = HOLD_PERIOD - 1                   # 10 growth periods
    n_early    = n_total - N_TERMINAL_REV           # 6 stochastic periods
    for i, (ptype, grp) in enumerate(data.groupby("proptype", sort=False)):
        seed0 = 1000 + i
        row   = grp.iloc[0]
        # Solve early-year mean so that:
        #   n_early * E[log(1+g_early)] + N_TERMINAL_REV * log(1+TERMINAL_REV_GROWTH)
        #   == n_total * log(1+drevenue)
        log_total     = n_total * np.log1p(row.drevenue)
        log_terminal  = N_TERMINAL_REV * np.log1p(TERMINAL_REV_GROWTH)
        cagr_early    = np.expm1((log_total - log_terminal) / n_early)
        rows.append({
            "proptype":    ptype,
            "drev_mu_adj": solve_mu_for_target_cagr(cagr_early, row.stdevrev, row.skewrev, seed=seed0),
            "dexp_mu_adj": solve_mu_for_target_cagr(row.dexpense, row.stdevexpense, row.skewexpense, seed=seed0 + 5000),
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# 4.  VECTORISED SIMULATION ENGINE
#     For each property type we draw ALL simulations × all years at once,
#     avoiding any Python loop over simulations.
# ---------------------------------------------------------------------------
def _moody_rating(ann_el: float) -> str:
    if not np.isfinite(ann_el): return "N/A"
    if ann_el <= 0.0001: return "Aaa"
    if ann_el <= 0.0004: return "Aa"
    if ann_el <= 0.0010: return "A"
    if ann_el <= 0.0025: return "Baa"
    if ann_el <= 0.0075: return "Ba"
    if ann_el <= 0.0250: return "B"
    return "Caa-C"


def irr_safe(cashflows: np.ndarray) -> float:
    """Newton-based IRR; returns NaN if no sign change or solver fails."""
    cf = np.asarray(cashflows, dtype=float)
    if not (np.isfinite(cf).all() and (cf < 0).any() and (cf > 0).any()):
        return np.nan
    # use numpy_financial if available, else manual Newton
    try:
        import numpy_financial as npf
        val = npf.irr(cf)
        return float(val) if np.isfinite(val) else np.nan
    except Exception:
        pass
    # manual Newton fallback
    r = 0.10
    for _ in range(200):
        t    = np.arange(len(cf), dtype=float)
        pv   = cf / (1 + r) ** t
        dpv  = -t * cf / (1 + r) ** (t + 1)
        npv  = pv.sum()
        dnpv = dpv.sum()
        if abs(dnpv) < 1e-14:
            break
        r_new = r - npv / dnpv
        if abs(r_new - r) < 1e-8:
            return float(r_new) if np.isfinite(r_new) else np.nan
        r = r_new
    return np.nan


def irr_batch(cf_matrix: np.ndarray) -> np.ndarray:
    """
    Vectorised IRR via Newton's method on the full (n_sim, n_periods) matrix.
    ~50-100x faster than a Python loop over irr_safe() at 10k sims.
    """
    n_sim, n_t = cf_matrix.shape
    t    = np.arange(n_t, dtype=float)
    r    = np.full(n_sim, 0.10)

    for _ in range(200):
        disc  = (1.0 + r[:, None]) ** t[None, :]          # (n_sim, n_t)
        pv    = cf_matrix / disc
        dpv   = -t[None, :] * cf_matrix / (disc * (1.0 + r[:, None]))
        npv   = pv.sum(axis=1)
        dnpv  = dpv.sum(axis=1)
        safe  = np.abs(dnpv) > 1e-14
        r_new = np.where(safe, r - npv / np.where(safe, dnpv, 1.0), r)
        # clamp r to (-1, 100) to prevent wild divergence in multi-sign-change CFs
        r_new = np.clip(r_new, -0.9999, 100.0)
        if np.abs(r_new - r).max() < 1e-8:
            r = r_new
            break
        r = r_new

    # Verify convergence: NPV at found r must be near zero.
    # When CFs have multiple sign changes Newton can converge to a spurious root
    # (e.g. NPV → cf_0 as r → -∞) that is mathematically wrong but finite.
    disc_final = (1.0 + r[:, None]) ** t[None, :]
    npv_final  = (cf_matrix / disc_final).sum(axis=1)
    tol        = 1e-2 * np.abs(cf_matrix[:, 0])   # 1% of purchase price
    bad_root   = np.abs(npv_final) > tol

    valid = (np.isfinite(cf_matrix).all(axis=1) &
             (cf_matrix < 0).any(axis=1) &
             (cf_matrix > 0).any(axis=1))
    r[~valid]          = np.nan
    r[~np.isfinite(r)] = np.nan
    r[bad_root]        = np.nan
    return r


# Default credit parameter set; calibration sweeps pass overrides.
# edf_floor: minimum annual default probability — performing stabilized CRE
#   loans historically default ~0.3-0.5%/yr even when DSCR/LTV look pristine
#   (idiosyncratic risk the covariates can't see).
# lgd_floor: minimum severity given default — workouts always incur costs,
#   even when collateral fully covers the loan.
# mat_ltv_lo / mat_ltv_trigger: maturity default at the balloon is a
#   value-based refinancing-gap ramp. Below mat_ltv_lo the balloon
#   refinances comfortably (P=0); above mat_ltv_trigger the borrower is
#   underwater beyond any bridge and always defaults (P=1). Between the two,
#   default probability rises linearly: the loan has positive paper equity
#   but can't be taken out at par (max refi proceeds ~70-75% LTV), which is
#   historically the dominant CMBS default channel.
# mat_cure: share of maturity defaults that still resolve with no principal
#   loss (extension while values recover; KBRA SASB shows many
#   moderate-leverage defaults resolve lossless — blended severity 11% vs
#   40% conditional on a meaningful loss).
CREDIT_PARAMS = dict(
    a0=EDF_A0, a1=EDF_A1, a2=EDF_A2, a3=EDF_A3,
    lgd_ongoing=LGD_ONGOING_PER_YR, lgd_onetime=LGD_ONETIME,
    edf_floor=0.004, lgd_floor=0.15,
    mat_ltv_lo=0.85, mat_ltv_trigger=1.05, mat_cure=0.30,
)


def run_credit_model(dscr_all: np.ndarray, mv_all: np.ndarray,
                     loan_amt: float, value: float, coupon: float,
                     proptype: str, u_def: np.ndarray,
                     params: dict | None = None):
    """Two-legged default model evaluated on pre-simulated paths:
    term defaults via a CMM-style logistic hazard (years 1-10), plus a
    deterministic maturity refinancing test at the balloon. Structural LGD.

    Separated from the path simulation so calibration sweeps can re-price
    default risk under new parameters without re-running the Monte Carlo.
    dscr_all/mv_all are (n_sim, 10); u_def is (n_sim, 12) — ten hazard draws,
    one maturity-ramp draw, one maturity-cure draw. Returns
    (is_default, loss_sev); cured maturity defaults count as defaults with
    zero loss (KBRA convention, so reported PD is default incidence and
    Avg_LGD is blended severity).
    """
    p = {**CREDIT_PARAMS, **(params or {})}

    ltv_t = loan_amt / np.maximum(mv_all, 0.01 * value)               # (n_sim, 10)

    # ---- Leg 1: term default hazard (annual EDF via sigmoid) ----
    z_edf = (p["a0"]
             + p["a1"] * np.maximum(0.0, 1.5 - dscr_all)
             + p["a2"] * np.maximum(0.0, dscr_all - 1.5)
             + p["a3"] * (ltv_t - 0.60))
    annual_edf = 1.0 / (1.0 + np.exp(-np.clip(z_edf, -20.0, 20.0)))  # (n_sim, 10)
    annual_edf = np.maximum(annual_edf, p["edf_floor"])

    # Annual Bernoulli; only first default in a sim counts
    yr_defaults = u_def[:, :10] < annual_edf                           # (n_sim, 10)
    has_default = yr_defaults.any(axis=1)                             # (n_sim,)
    def_yr_idx  = np.where(has_default,
                            yr_defaults.argmax(axis=1), 0)             # (n_sim,)

    # ---- Leg 2: maturity default at the balloon (refinancing-gap ramp) ----
    # Value-based: default probability is 0 below mat_ltv_lo, rises linearly
    # through the refi-gap zone (positive paper equity but too little for a
    # par take-out), and hits 1 at mat_ltv_trigger — beyond which the
    # borrower is underwater past any bridge and repayment of the balloon,
    # unlike interim debt service, is not optional.
    exit_ltv = ltv_t[:, 9]
    p_mat    = np.clip((exit_ltv - p["mat_ltv_lo"])
                       / max(p["mat_ltv_trigger"] - p["mat_ltv_lo"], 1e-9),
                       0.0, 1.0)
    mat_default = (~has_default) & (u_def[:, 10] < p_mat)

    # A share of maturity defaults cure (extension / workout, values recover,
    # loan ultimately repays at par) — defaults with zero principal loss.
    mat_cured   = mat_default & (u_def[:, 11] < p["mat_cure"])

    has_default = has_default | mat_default
    def_yr_idx  = np.where(mat_default, 9, def_yr_idx)

    # LGD = principal shortfall + carry costs (CMM Structural LGD, Table 15)
    t_res      = T_RESOLVE.get(cmm_class(proptype), T_RESOLVE_DEFAULT)
    carry_frac = p["lgd_ongoing"] * t_res + p["lgd_onetime"]
    lost_int   = coupon * t_res * loan_amt

    n_sim      = dscr_all.shape[0]
    rec_gross  = mv_all[np.arange(n_sim), def_yr_idx]
    net_rec    = np.maximum(0.0, rec_gross * (1.0 - carry_frac) - lost_int)
    raw_lgd    = np.maximum(0.0, (loan_amt - net_rec) / loan_amt)

    # Property-type LGD scalar (CMM Table 12 calibration)
    lgd_scale  = LGD_SCALAR.get(cmm_class(proptype), LGD_SCALAR_DEFAULT)
    adj_lgd    = np.clip(raw_lgd * lgd_scale, p["lgd_floor"], 1.0)

    is_default = has_default.astype(int)
    loss_sev   = np.where(has_default & ~mat_cured, adj_lgd, 0.0)
    return is_default, loss_sev


def simulate_property_type(row: pd.Series, n_sim: int, seed: int = 42
                            ) -> dict:
    """
    Vectorised simulation for one property type.
    Returns dicts of DataFrames: irr_data, expanded_data, debt_data.
    """
    rng = np.random.default_rng(seed)

    # ----- parameters -----
    mu_rev  = row.drev_mu_adj
    sd_rev  = row.stdevrev
    dial_rev = row.skewrev

    mu_exp  = row.dexp_mu_adj
    sd_exp  = row.stdevexpense
    dial_exp = row.skewexpense

    capex_mean = row.capex
    capex_sd   = row.stdevcapex
    capex_dial = row.skewcapex

    cspread_sd   = row.stdevcapspread * 0.5
    cspread_dial = row.skewcapspread

    cap0  = row.caprate
    mu_cs = row.capspread   # long-run terminal spread (O-U target)

    value    = row.value
    ltv      = row.ltv
    spread   = row.spread   # decimal
    spread_bps = row.spread_bps

    T = HOLD_PERIOD  # 11 rows per sim

    # ----- correlated growth draws  shape (n_sim, T-1)  -----
    # Split into n_early stochastic years + N_TERMINAL_REV terminal years.
    n_total_growth = T - 1               # 10 growth periods
    n_early = n_total_growth - N_TERMINAL_REV   # 6 stochastic growth periods

    # Early years: Gaussian copula → skew-normal (rev correlated with exp)
    z = rng.multivariate_normal(
        [0, 0],
        [[1, RHO], [RHO, 1]],
        size=(n_sim, n_early)
    )  # shape (n_sim, n_early, 2)
    u_rev_early = stats.norm.cdf(z[:, :, 0])   # (n_sim, n_early)
    u_exp_early = stats.norm.cdf(z[:, :, 1])

    g_rev_early = np.maximum(
        skewnorm_ppf_cp(u_rev_early.ravel(), mu_rev, sd_rev, dial_rev).reshape(n_sim, n_early),
        GROWTH_FLOOR
    )
    g_exp_early = np.maximum(
        skewnorm_ppf_cp(u_exp_early.ravel(), mu_exp, sd_exp, dial_exp).reshape(n_sim, n_early),
        GROWTH_FLOOR
    )

    # Terminal years: mean pinned at TERMINAL_REV_GROWTH (preserves CAGR);
    # sd fades from sd_rev (year n_early+1) down to TERMINAL_REV_SD (final year)
    # so the distribution tapers smoothly rather than creating a hard spike.
    term_w    = np.linspace(1.0 / N_TERMINAL_REV, 1.0, N_TERMINAL_REV)  # [0.25,0.50,0.75,1.00]
    term_sds  = (1.0 - term_w) * sd_rev + term_w * TERMINAL_REV_SD      # (N_TERMINAL_REV,)
    g_rev_term = (rng.standard_normal((n_sim, N_TERMINAL_REV))
                  * term_sds[None, :] + TERMINAL_REV_GROWTH)             # (n_sim, 4)
    z_exp_term = rng.multivariate_normal(
        [0, 0], [[1, RHO], [RHO, 1]], size=(n_sim, N_TERMINAL_REV)
    )
    u_exp_term = stats.norm.cdf(z_exp_term[:, :, 1])
    g_exp_term = np.maximum(
        skewnorm_ppf_cp(u_exp_term.ravel(), mu_exp, sd_exp, dial_exp).reshape(n_sim, N_TERMINAL_REV),
        GROWTH_FLOOR
    )

    # Combine: early years first, then terminal  → (n_sim, T-1)
    g_rev_raw = np.hstack([g_rev_early, g_rev_term])
    g_exp_raw = np.hstack([g_exp_early, g_exp_term])

    g_rev = g_rev_raw   # floors already applied above
    g_exp = g_exp_raw

    # ----- capex draws  (n_sim, T-1) -----
    capex_draws = np.clip(
        skewnorm_rvs_cp(n_sim * (T - 1), capex_mean, capex_sd, capex_dial, rng)
        .reshape(n_sim, T - 1),
        0, 1
    )

    # ----- cap-spread path: deterministic glide + zero-mean AR(1) noise -----
    # Glide: same linear path as the base case (cap0 → cap0+mu_cs by year 10,
    # flat at year 11), so E[running_cap_t] == base_case_cap_t exactly.
    t_idx  = np.arange(T, dtype=float)
    phase  = np.minimum(t_idx, 9) / 9          # 0→1 over years 1-10, flat at 11
    glide  = mu_cs * phase                      # shape (T,)

    # Noise: zero-mean AR(1)  η_t = (1-θ)·η_{t-1} + ε_t,  η_0 = 0
    spread_shock = skewnorm_rvs_cp(
        n_sim * (T - 1), 0, cspread_sd, cspread_dial, rng
    ).reshape(n_sim, T - 1)

    eta = np.zeros((n_sim, T))
    for i in range(1, T):
        eta[:, i] = (1 - THETA) * eta[:, i - 1] + spread_shock[:, i - 1]

    # Full cap-spread = glide (shared across sims) + zero-mean noise per sim
    cs          = glide[None, :] + eta          # (n_sim, T)
    running_cap = cap0 + cs                     # (n_sim, T)

    # ----- revenue / expense paths  (n_sim, T) -----
    # Revenue mean-reverts to its expected log-trend: each year the deviation
    # from trend decays by REV_MEAN_REVERSION before the new shock lands, so
    # shocks are transitory (hotels recover after downturns) instead of
    # compounding forever. The trend uses the same expected log-growth per year
    # as the Jensen-solved draws, so E[log rev_t] stays exactly on trend and
    # realized CAGRs still match the inputs.
    log_g_early = (n_total_growth * np.log1p(row.drevenue)
                   - N_TERMINAL_REV * np.log1p(TERMINAL_REV_GROWTH)) / n_early
    log_trend_g = np.concatenate([
        np.full(n_early, log_g_early),
        np.full(N_TERMINAL_REV, np.log1p(TERMINAL_REV_GROWTH)),
    ])
    log_trend = np.log(row.revenue) + np.concatenate([[0.0], np.cumsum(log_trend_g)])

    # Expense trend is simpler: no terminal pinning, so it compounds at the
    # input CAGR for all 10 growth years.
    log_exp_trend = np.log(row.expense) + np.arange(T) * np.log1p(row.dexpense)

    log_rev = np.empty((n_sim, T))
    log_rev[:, 0] = np.log(row.revenue)
    log_exp = np.empty((n_sim, T))
    log_exp[:, 0] = np.log(row.expense)

    for i in range(1, T):
        pull_r = REV_MEAN_REVERSION * (log_trend[i - 1] - log_rev[:, i - 1])
        pull_e = EXP_MEAN_REVERSION * (log_exp_trend[i - 1] - log_exp[:, i - 1])
        log_rev[:, i] = log_rev[:, i - 1] + np.log1p(g_rev[:, i - 1]) + pull_r
        log_exp[:, i] = log_exp[:, i - 1] + np.log1p(g_exp[:, i - 1]) + pull_e
    rev = np.exp(log_rev)
    exp = np.exp(log_exp)

    # capex for year-0 placeholder = base capex; years 1..T-1 = draws
    capex_full = np.empty((n_sim, T))
    capex_full[:, 0] = capex_mean
    capex_full[:, 1:] = capex_draws

    # ----- IRR (vectorised) -----
    noi     = rev - exp                         # (n_sim, T)
    cf_ops  = noi - noi * capex_full            # operating CF

    exit_cap_idx = 9                            # year index 9 = Year 10
    exit_cap = np.maximum(0.03, running_cap[:, exit_cap_idx])
    y11_noi  = rev[:, 10] - exp[:, 10]
    end_val  = np.maximum(y11_noi / exit_cap, 0.30 * value)

    # CF vector: t=0 purchase, t=1..9 operating, t=10 operating + sale
    cf_t10 = cf_ops[:, 9] + end_val
    cf_matrix = np.column_stack([
        np.full(n_sim, -value),
        cf_ops[:, :9],
        cf_t10
    ])  # (n_sim, 11)

    irr_vals = irr_batch(cf_matrix)

    # ----- Debt metrics (interim covenant default + maturity default) -----
    loan_amt  = ltv * value
    annual_ds = max(loan_amt * (BASE_SOFR + spread), 1e-6)  # IO annual debt service

    # DSCR and mark-to-market value paths for all 10 hold years, fed to the
    # CMM hazard + structural LGD model (run_credit_model).
    noi_ops  = noi[:, :9]                                          # (n_sim, 9)
    noi_fwd  = noi[:, 1:10]                                        # (n_sim, 9) forward NOI
    cap_mid  = np.maximum(0.03, running_cap[:, :9])                # (n_sim, 9)
    mv_mid   = np.maximum(noi_fwd / cap_mid, 0.30 * value)         # (n_sim, 9) mark-to-market
    dscr_mid = noi_ops / annual_ds                                  # (n_sim, 9)

    dscr_all = np.hstack([dscr_mid,
                           (noi[:, 9] / annual_ds).reshape(-1, 1)])   # (n_sim, 10)
    mv_all   = np.hstack([mv_mid, end_val.reshape(-1, 1)])             # (n_sim, 10)

    coupon = BASE_SOFR + spread
    u_def  = rng.random((n_sim, 12))   # 10 hazard yrs + maturity ramp + cure draws
    is_default, loss_sev = run_credit_model(
        dscr_all, mv_all, loan_amt, value, coupon, row.proptype, u_def)

    sim_ids = np.arange(1, n_sim + 1)
    ptype   = row.proptype

    # ----- assemble expanded_data DataFrame (vectorised, no Python loops) -----
    years = np.arange(row.year, row.year + T)
    nan_col     = np.full((n_sim, 1), np.nan)
    # realized growth (post mean reversion), so drill-down tables tie out to levels
    g_rev_real  = rev[:, 1:] / rev[:, :-1] - 1.0
    g_exp_real  = exp[:, 1:] / exp[:, :-1] - 1.0
    g_rev_full  = np.hstack([nan_col, g_rev_real]).ravel()   # prepend NaN for t=0
    g_exp_full  = np.hstack([nan_col, g_exp_real]).ravel()
    expanded_df = pd.DataFrame({
        "simulation_id":     np.repeat(sim_ids, T),
        "proptype":          ptype,
        "year":              np.tile(years, n_sim),
        "revenue":           rev.ravel(),
        "expense":           exp.ravel(),
        "capex":             capex_full.ravel(),
        "running_cap_rate":  running_cap.ravel(),
        "capspread":         cs.ravel(),
        "random_growth_rev": g_rev_full,
        "random_growth_exp": g_exp_full,
        "noi":               noi.ravel(),
        "IRR":               np.repeat(irr_vals, T),
    })

    irr_df = pd.DataFrame({
        "simulation_id": sim_ids,
        "proptype": ptype,
        "IRR": irr_vals,
    })

    debt_df = pd.DataFrame({
        "simulation_id": sim_ids,
        "proptype":       ptype,
        "spread_bps":     spread_bps,
        "is_default":     is_default,
        "loss_sev":       loss_sev,
    })

    # ----- NCREIF-style annual total returns (n_sim, 10) -----
    # MV at end of each hold year (1-indexed years 1..10):
    #   MV_t = NOI_{t+1} / running_cap_t  (forward NOI / cap rate)
    # noi[:, k] = NOI in period k (k=0 → year 1 ops, k=9 → year 10 ops, k=10 → y11)
    # running_cap[:, k] = cap rate at end of period k
    mv = np.empty((n_sim, 10))
    for k in range(9):                              # k=0..8 → years 1..9
        mv[:, k] = noi[:, k + 1] / np.maximum(0.03, running_cap[:, k])
    mv[:, 9] = end_val                              # year 10 = exit value

    bv = np.empty((n_sim, 10))
    bv[:, 0] = value                                # purchase price
    bv[:, 1:] = mv[:, :-1]                         # bv[t] = mv[t-1]

    # NCREIF total return = (NOI + MV - BV_lag - CapEx) / BV_lag
    # capex_full[:,1:10] are fractions of NOI; convert to dollar amounts
    capex_dollars = noi[:, :10] * capex_full[:, :10]              # (n_sim, 10)
    annual_ret = (noi[:, :10] + mv - bv - capex_dollars) / np.maximum(bv, 1.0)  # (n_sim, 10)
    annual_ret = np.clip(annual_ret, -1.0, 10.0)    # guard against degenerate sims

    # per-sim cumulative products for CAGR
    cum3 = np.prod(1.0 + annual_ret[:, :3], axis=1) ** (1.0 / 3) - 1.0
    cum5 = np.prod(1.0 + annual_ret[:, :5], axis=1) ** (1.0 / 5) - 1.0

    returns_df = pd.DataFrame(
        {f"year_{t+1}": np.median(annual_ret[:, t]) for t in range(10)},
        index=[0]
    )
    returns_df["cagr_3yr"] = float(np.median(cum3))
    returns_df["cagr_5yr"] = float(np.median(cum5))
    returns_df.insert(0, "proptype", ptype)

    return {"irr_data": irr_df, "expanded_data": expanded_df,
            "debt_data": debt_df, "returns_data": returns_df,
            # raw inputs to run_credit_model, kept for calibration sweeps
            "credit_paths": {"dscr_all": dscr_all, "mv_all": mv_all,
                              "u_def": u_def, "loan_amt": loan_amt,
                              "value": value, "coupon": coupon,
                              "spread_bps": spread_bps, "proptype": ptype,
                              "debt_yield": row.debt_yield}}


# ---------------------------------------------------------------------------
# 5.  BASE-CASE DCF  (deterministic: uses raw assumption means)
# ---------------------------------------------------------------------------
def run_base_case_dcf(row: pd.Series) -> pd.DataFrame:
    T = HOLD_PERIOD
    years = np.arange(row.year, row.year + T)

    # deterministic cap-rate path (linear → terminal by Year 10, flat Year 11)
    cap0  = row.caprate
    capT  = row.caprate + row.capspread
    t_idx = np.arange(T)
    phase = np.minimum(t_idx, 9) / 9
    running_cap = cap0 + (capT - cap0) * phase

    rev  = np.empty(T);  rev[0]  = row.revenue
    exp_ = np.empty(T);  exp_[0] = row.expense
    capex_arr = np.full(T, row.capex)

    for i in range(1, T):
        rev[i]  = rev[i - 1]  * (1 + row.drevenue)
        exp_[i] = exp_[i - 1] * (1 + row.dexpense)

    y11_noi = rev[10] - exp_[10]
    exit_cap = max(0.03, running_cap[9])
    end_val  = max(y11_noi / exit_cap, 0.30 * row.value)

    noi    = rev - exp_
    cf_ops = noi - noi * capex_arr

    terminal_col = np.zeros(T)
    terminal_col[9] = end_val

    totalcf = cf_ops + terminal_col
    totalcf[10] = np.nan   # year 11 = forward NOI only

    cf_vec = np.concatenate([[-row.value], cf_ops[:9], [cf_ops[9] + end_val]])
    irr    = irr_safe(cf_vec)

    df = pd.DataFrame({
        "proptype":         row.proptype,
        "year":             years,
        "revenue":          rev,
        "expense":          exp_,
        "noi":              noi,
        "capex":            capex_arr,
        "capspread":        running_cap - cap0,
        "running_cap_rate": running_cap,
        "totalcf":          totalcf,
        "IRR":              irr,
    })
    df["t"] = np.arange(1, T + 1)
    return df


def run_base_case_loan(row: pd.Series) -> pd.DataFrame:
    dcf = run_base_case_dcf(row)

    loan_amt   = row.ltv  * row.value
    coupon     = BASE_SOFR + row.spread
    annual_int = loan_amt * coupon

    dcf = dcf.copy()
    dcf["annual_interest"] = annual_int
    dcf["DSCR"]            = dcf["noi"] / annual_int
    dcf["Debt_Yield"]      = dcf["noi"] / loan_amt
    dcf["implied_value"]   = dcf["noi"] / dcf["running_cap_rate"]
    dcf["LTV"]             = loan_amt / dcf["implied_value"]

    exit_val = dcf.loc[dcf["t"] == 10, "noi"].values[0] / max(0.03, dcf.loc[dcf["t"] == 10, "running_cap_rate"].values[0])
    exit_val = max(exit_val, 0.30 * row.value)

    dcf["Exit_Value"] = np.where(dcf["t"] == 10, exit_val, np.nan)
    dcf["Exit_LTV"]   = np.where(dcf["t"] == 10, loan_amt / exit_val, np.nan)

    return dcf.loc[dcf["t"] <= 10]


# ---------------------------------------------------------------------------
# 6.  SUMMARY / RISK METRICS
# ---------------------------------------------------------------------------
def compute_summary(irr_df: pd.DataFrame) -> pd.DataFrame:
    def _row(grp):
        vals = grp["IRR"].dropna().values
        mean_irr = vals.mean()
        sd_irr   = vals.std()
        dd       = np.std(np.maximum(0, MAR - vals))
        sharpe   = (mean_irr - RISK_FREE) / sd_irr if sd_irr > 0 else np.nan
        sortino  = (mean_irr - MAR) / dd           if dd > 0   else np.nan
        return pd.Series({
            "mean_IRR": mean_irr, "sd_IRR": sd_irr,
            "min_IRR": vals.min(), "max_IRR": vals.max(),
            "sharpe_ratio": sharpe, "sortino_ratio": sortino,
        })
    return irr_df.groupby("proptype").apply(_row).reset_index()


def compute_calibration(data: pd.DataFrame,
                         random_variables: pd.DataFrame) -> pd.DataFrame:
    inputs = data.groupby("proptype").first()[
        ["drevenue","dexpense","capex","caprate","capspread",
         "stdevrev","stdevexpense","stdevcapex","stdevcapspread"]
    ].reset_index()

    # Rank each row's position within (proptype, simulation_id) — avoids nested apply
    rv = random_variables.sort_values(["proptype","simulation_id","year"])
    rv = rv.copy()
    rv["_rank"] = (rv.groupby(["proptype","simulation_id"])["year"]
                     .rank(method="first").astype(int))

    key = ["proptype","simulation_id"]
    first_rows = (rv[rv["_rank"] == 1 ][key + ["revenue","expense","running_cap_rate"]]
                    .rename(columns={"revenue": "revenue_first",
                                     "expense": "expense_first",
                                     "running_cap_rate": "start_cap_rate"}))
    last_rows  = (rv[rv["_rank"] == 11][key + ["revenue","expense"]]
                    .rename(columns={"revenue": "revenue_last",
                                     "expense": "expense_last"}))
    exit_rows  = rv[rv["_rank"] == 10][key + ["running_cap_rate"]]
    capex_rows = rv[(rv["_rank"] >= 2) & (rv["_rank"] <= 10)][key + ["capex"]]

    avg_capex = (capex_rows.groupby(key)["capex"]
                            .mean().reset_index(name="avg_capex"))

    merged = first_rows.merge(last_rows, on=key)
    merged["rev_cagr"] = (merged["revenue_last"] / merged["revenue_first"]) ** (1/10) - 1
    merged["exp_cagr"] = (merged["expense_last"]  / merged["expense_first"])  ** (1/10) - 1
    merged = merged.merge(exit_rows, on=key)
    merged = merged.merge(avg_capex,  on=key)

    realized = (merged.groupby("proptype")
                       .agg(realized_rev_cagr=("rev_cagr","mean"),
                            realized_exp_cagr=("exp_cagr","mean"),
                            realized_start_cap=("start_cap_rate","mean"),
                            realized_exit_cap=("running_cap_rate","mean"),
                            realized_capex    =("avg_capex","mean"))
                       .reset_index())

    cal = inputs.merge(realized, on="proptype")
    cal["rev_cagr_diff"] = cal["realized_rev_cagr"] - cal["drevenue"]
    cal["exp_cagr_diff"] = cal["realized_exp_cagr"] - cal["dexpense"]
    cal["capex_diff"]    = cal["realized_capex"]    - cal["capex"]
    cal["exit_cap_diff"] = cal["realized_exit_cap"] - (cal["caprate"] + cal["capspread"])
    return cal


def compute_debt_summary(debt_raw: pd.DataFrame) -> pd.DataFrame:
    ANN_EL_FLOOR = 0.0003   # 3 bps minimum annual expected loss
    def _row(grp):
        pd_val  = grp["is_default"].mean()
        lgd     = (grp["loss_sev"].sum() / grp["is_default"].sum()
                   if grp["is_default"].sum() > 0 else 0.0)
        total_el = pd_val * lgd
        # hazard-consistent annualization: the constant annual loss rate that
        # compounds to the 10-yr total EL (not total/10, which assumes linearity)
        ann_el   = max(1.0 - (1.0 - total_el) ** (1.0 / 10), ANN_EL_FLOOR)
        sp_bps   = grp["spread_bps"].iloc[0]
        return pd.Series({
            "Spread_bps": sp_bps,
            "PD":   pd_val,
            "Avg_LGD": lgd,
            "Total_EL": total_el,
            "Ann_EL":   ann_el,
            "Ann_EL_bps": ann_el * 10_000,
            "Loss_Adjusted_Spread_bps": sp_bps - ann_el * 10_000,
            "Rating": _moody_rating(ann_el),
        })
    return debt_raw.groupby("proptype").apply(_row).reset_index()


# ---------------------------------------------------------------------------
# 7.  RUN ALL SIMULATIONS
# ---------------------------------------------------------------------------
print("Loading data …")
data = load_data()

print("Solving CAGR-consistent means (Jensen correction) …")
mu_adj = precompute_mu_adjustments(data)
data   = data.merge(mu_adj, on="proptype", how="left")

property_types   = sorted(data["proptype"].unique())
data_by_proptype = {pt: data[data["proptype"] == pt].iloc[0] for pt in property_types}

print(f"Running {SIM_COUNT:,} simulations × {len(property_types)} property types …")
all_irr, all_expanded, all_debt, all_returns = [], [], [], []
credit_paths_by_proptype = {}

for i, ptype in enumerate(property_types):
    print(f"  [{i+1}/{len(property_types)}] {ptype}")
    res = simulate_property_type(data_by_proptype[ptype], SIM_COUNT, seed=42 + i)
    all_irr.append(res["irr_data"])
    all_expanded.append(res["expanded_data"])
    all_debt.append(res["debt_data"])
    all_returns.append(res["returns_data"])
    credit_paths_by_proptype[ptype] = res["credit_paths"]

irr_results      = pd.concat(all_irr,      ignore_index=True)
random_variables = pd.concat(all_expanded, ignore_index=True)
debt_raw         = pd.concat(all_debt,     ignore_index=True)
annual_returns   = pd.concat(all_returns,  ignore_index=True)

print("Computing summaries …")
summary_results = compute_summary(irr_results)
calibration_table = compute_calibration(data, random_variables)
debt_summary = compute_debt_summary(debt_raw)

base_case_dcfs  = pd.concat([run_base_case_dcf(data_by_proptype[pt])  for pt in property_types])
base_case_loans = pd.concat([run_base_case_loan(data_by_proptype[pt]) for pt in property_types])

print("Simulations complete. Starting API server …\n")


# ---------------------------------------------------------------------------
# 8.  HELPERS
# ---------------------------------------------------------------------------
def _nan_to_none(v):
    """Convert NaN/inf to None for JSON serialisation."""
    if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
        return None
    return v

def _clean_records(df: pd.DataFrame) -> list:
    """Convert DataFrame to JSON-safe list of dicts."""
    return [
        {k: _nan_to_none(v) for k, v in row.items()}
        for row in df.to_dict("records")
    ]

def _histogram_bins(vals: np.ndarray, n_bins: int = 50) -> list:
    """Return pre-computed histogram bins as list of {x0, x1, count}."""
    vals = vals[np.isfinite(vals)]
    if len(vals) == 0:
        return []
    counts, edges = np.histogram(vals, bins=n_bins)
    return [{"x0": float(edges[i]), "x1": float(edges[i+1]), "count": int(counts[i])}
            for i in range(len(counts))]

def fmt_df_dollar(df: pd.DataFrame, cols: list) -> pd.DataFrame:
    df = df.copy()
    for c in cols:
        if c in df.columns:
            df[c] = df[c].map(lambda v: f"${v:,.2f}" if pd.notna(v) else "")
    return df


# ---------------------------------------------------------------------------
# 9.  FASTAPI APP + ENDPOINTS
# ---------------------------------------------------------------------------
FRONTEND_DIST = os.path.join(HERE, "frontend", "dist")

app = FastAPI(title="MIM Stochastic RE Model")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/property-types")
def get_property_types():
    return property_types


@app.get("/api/summary")
def get_summary():
    return _clean_records(summary_results)


@app.get("/api/irr-histogram")
def get_irr_histogram(proptype: str = Query(...)):
    vals = irr_results[irr_results["proptype"] == proptype]["IRR"].dropna().values
    return {"bins": _histogram_bins(vals)}


@app.get("/api/irr-kde")
def get_irr_kde(proptype: str = Query(...), n_points: int = 200):
    """Gaussian KDE for smooth density curve (mirrors R's geom_density)."""
    from scipy.stats import gaussian_kde
    vals = irr_results[irr_results["proptype"] == proptype]["IRR"].dropna().values
    if len(vals) < 2:
        return {"points": []}
    kde  = gaussian_kde(vals, bw_method="scott")
    lo   = float(np.percentile(vals, 0.5))
    hi   = float(np.percentile(vals, 99.5))
    xs   = np.linspace(lo, hi, n_points)
    ys   = kde(xs)
    return {"points": [{"x": float(x), "y": float(y)} for x, y in zip(xs, ys)]}


@app.get("/api/variable-histogram")
def get_variable_histogram(proptype: str = Query(...), variable: str = Query(...)):
    sub  = random_variables[random_variables["proptype"] == proptype]
    vals = sub[variable].dropna().values
    return {"bins": _histogram_bins(vals), "variable": variable}


@app.get("/api/calibration")
def get_calibration():
    return _clean_records(calibration_table)


@app.get("/api/debt-summary")
def get_debt_summary():
    return _clean_records(debt_summary)


@app.get("/api/annual-returns")
def get_annual_returns():
    return _clean_records(annual_returns)


@app.get("/api/base-case-dcf")
def get_base_case_dcf(proptype: str = Query(...)):
    d0 = base_case_dcfs[base_case_dcfs["proptype"] == proptype].sort_values("t").reset_index(drop=True)

    purchase_row = {
        "t": 0, "year": int(d0["year"].iloc[0]) - 1,
        "row_type": "Purchase",
        "revenue": None, "expense": None, "noi": None, "capex": None,
        "capspread": None, "running_cap_rate": None,
        "totalcf": -float(data_by_proptype[proptype].value),
    }
    rows = [purchase_row]
    for _, r in d0.iterrows():
        row_type = "Forward NOI (valuation only)" if r["t"] == 11 else "Operating (CF year)"
        rows.append({
            "t": int(r["t"]), "year": int(r["year"]), "row_type": row_type,
            "revenue": _nan_to_none(r["revenue"]), "expense": _nan_to_none(r["expense"]),
            "noi": _nan_to_none(r["noi"]), "capex": _nan_to_none(r["capex"]),
            "capspread": _nan_to_none(r["capspread"]),
            "running_cap_rate": _nan_to_none(r["running_cap_rate"]),
            "totalcf": _nan_to_none(r["totalcf"]),
        })

    irr_val      = _nan_to_none(float(d0["IRR"].iloc[0]))
    avg_rev_cagr = (d0["revenue"].iloc[-1] / d0["revenue"].iloc[0]) ** (1/10) - 1
    avg_exp_cagr = (d0["expense"].iloc[-1]  / d0["expense"].iloc[0])  ** (1/10) - 1
    avg_capex    = float(d0.iloc[1:10]["capex"].mean())
    # Match Shiny: start_cap = Year-1 NOI / Value  (same as going-in cap rate)
    start_noi    = float(d0["revenue"].iloc[0]) - float(d0["expense"].iloc[0])
    start_cap    = start_noi / float(data_by_proptype[proptype].value)
    exit_cap     = float(d0["running_cap_rate"].iloc[9])

    return {
        "metrics": {
            "irr": irr_val, "start_cap": start_cap, "exit_cap": exit_cap,
            "avg_rev_growth": float(avg_rev_cagr), "avg_exp_growth": float(avg_exp_cagr),
            "avg_capex": avg_capex,
        },
        "rows": rows,
    }


@app.get("/api/base-case-loan")
def get_base_case_loan(proptype: str = Query(...)):
    d = base_case_loans[base_case_loans["proptype"] == proptype].copy()
    cols = ["year","noi","annual_interest","DSCR","Debt_Yield",
            "running_cap_rate","LTV","Exit_Value","Exit_LTV"]
    return _clean_records(d[cols])


@app.get("/api/sim-ids")
def get_sim_ids(proptype: str = Query(...)):
    ids = sorted(irr_results[irr_results["proptype"] == proptype]["simulation_id"].unique().tolist())
    return ids


@app.get("/api/individual-dcf")
def get_individual_dcf(proptype: str = Query(...), sim_id: int = Query(...)):
    d0 = (random_variables[
              (random_variables["proptype"]     == proptype) &
              (random_variables["simulation_id"] == sim_id)
          ].sort_values("year").reset_index(drop=True))

    d0 = d0.copy()
    d0["t"] = np.arange(1, len(d0) + 1)
    d0["cf"] = d0["noi"] - d0["noi"] * d0["capex"]
    exit_cap_val = max(0.03, float(d0.loc[d0["t"] == 10, "running_cap_rate"].values[0]))
    y11_noi      = float(d0.loc[d0["t"] == 11, "noi"].values[0])
    end_val      = max(y11_noi / exit_cap_val, 0.30 * float(data_by_proptype[proptype].value))
    d0["totalcf"] = d0["cf"]
    d0.loc[d0["t"] == 10, "totalcf"] += end_val
    d0.loc[d0["t"] == 11, "totalcf"] = np.nan

    irr_val      = _nan_to_none(float(d0["IRR"].iloc[0]))
    avg_rev_cagr = (d0["revenue"].iloc[-1] / d0["revenue"].iloc[0]) ** (1/10) - 1
    avg_exp_cagr = (d0["expense"].iloc[-1]  / d0["expense"].iloc[0])  ** (1/10) - 1
    avg_capex    = float(d0.iloc[1:10]["capex"].mean())
    start_cap    = float(d0["running_cap_rate"].iloc[0])
    exit_cap     = float(d0["running_cap_rate"].iloc[9])

    purchase_row = {
        "t": 0, "year": int(d0["year"].iloc[0]) - 1,
        "row_type": "Purchase",
        "revenue": None, "random_growth_rev": None,
        "expense": None, "random_growth_exp": None,
        "running_cap_rate": None, "noi": None,
        "totalcf": -float(data_by_proptype[proptype].value),
    }
    rows = [purchase_row]
    for _, r in d0.iterrows():
        row_type = "Forward NOI (valuation only)" if r["t"] == 11 else "Operating (CF year)"
        rows.append({
            "t": int(r["t"]), "year": int(r["year"]), "row_type": row_type,
            "revenue": _nan_to_none(r["revenue"]),
            "random_growth_rev": _nan_to_none(r.get("random_growth_rev")),
            "expense": _nan_to_none(r["expense"]),
            "random_growth_exp": _nan_to_none(r.get("random_growth_exp")),
            "running_cap_rate": _nan_to_none(r["running_cap_rate"]),
            "noi": _nan_to_none(r["noi"]),
            "totalcf": _nan_to_none(r["totalcf"]),
        })

    return {
        "metrics": {
            "irr": irr_val, "start_cap": start_cap, "exit_cap": exit_cap,
            "avg_rev_growth": float(avg_rev_cagr), "avg_exp_growth": float(avg_exp_cagr),
            "avg_capex": avg_capex,
        },
        "rows": rows,
    }


# Serve single-file CDN-based UI (no build step required)
STATIC_DIR = os.path.join(HERE, "static")
app.mount("/vendor", StaticFiles(directory=os.path.join(STATIC_DIR, "vendor")), name="vendor")

@app.get("/", include_in_schema=False)
def serve_ui():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8051, reload=False)


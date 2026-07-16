"""Sweep EDF/LGD parameters over cached simulation paths to find a set that
lands annual EL in the target band (~5-10 bps best sectors, ~50 bps worst).

Runs the full Monte Carlo once at import, then each candidate parameter set
re-prices all 21 sectors in milliseconds via run_credit_model.
"""
import itertools
import numpy as np
import pandas as pd

import sm_python as m


def el_table(params: dict) -> pd.DataFrame:
    rows = []
    for pt, cp in m.credit_paths_by_proptype.items():
        is_def, loss = m.run_credit_model(
            cp["dscr_all"], cp["mv_all"], cp["loan_amt"], cp["value"],
            cp["coupon"], pt, cp["u_def"], params)
        pd_val = is_def.mean()
        lgd = loss.sum() / is_def.sum() if is_def.sum() > 0 else 0.0
        total_el = pd_val * lgd
        ann_el_bps = (1.0 - (1.0 - total_el) ** 0.1) * 1e4
        rows.append({"proptype": pt, "PD": pd_val, "LGD": lgd,
                     "EL_bps": ann_el_bps})
    return pd.DataFrame(rows).sort_values("EL_bps").reset_index(drop=True)


# Historical priors (Fitch/KBRA/Moody's): these sectors should rank at the
# safe and risky ends respectively. Penalize orderings that violate them —
# quantile-only scoring accepts ladders whose ranking is scrambled (e.g.
# steep DSCR coefficients rank Self Storage risky because its day-one
# coverage is thin, inverting the historical record).
LOW_RISK  = ["Manufactured Housing", "Single-Family Rentals", "Self Storage",
             "Moderate Income Housing", "Medical Office", "Retail- Net Lease"]
HIGH_RISK = ["Full-Service Hotels", "Limited-Service Hotels", "Cold Storage",
             "Life Science", "Office (Excludes Life Science/Medical)"]


def score(tbl: pd.DataFrame) -> float:
    """Squared distance from the target EL ladder (bps) plus an ordering
    penalty anchored to the historical record. The anchors say best sectors
    ~5-10, mid ~12-15, upper ~20-25, worst ~50."""
    q = tbl.EL_bps.quantile
    targets = {0.0: 7.0, 0.25: 9.0, 0.5: 11.0, 0.75: 16.0, 1.0: 50.0}
    s = sum((q(p) - t) ** 2 for p, t in targets.items())

    rank = {pt: i for i, pt in enumerate(tbl.proptype)}  # 0 = safest of 21
    for pt in LOW_RISK:                                   # want rank <= 9
        s += 25.0 * max(0, rank[pt] - 9) ** 2
    for pt in HIGH_RISK:                                  # want rank >= 14
        s += 25.0 * max(0, 14 - rank[pt]) ** 2
    return s


if __name__ == "__main__":
    grid = {
        "a0":          [-6.5, -6.0],
        "a1":          [1.5, 2.0],
        "a3":          [1.0, 1.5],
        "lgd_ongoing": [0.057],
        "edf_floor":   [0.003, 0.004],
        "lgd_floor":   [0.10, 0.15],
        "mat_ltv_lo":  [0.80, 0.85, 0.90],
        "mat_ltv_trigger": [1.05],
        "mat_cure":    [0.10, 0.20, 0.30],
    }
    results = []
    for combo in itertools.product(*grid.values()):
        params = dict(zip(grid.keys(), combo))
        tbl = el_table(params)
        results.append((score(tbl), params, tbl))

    results.sort(key=lambda r: r[0])
    pd.set_option("display.width", 200)
    for sc, params, tbl in results[:3]:
        print(f"\n=== score {sc:,.0f}  params {params} ===")
        print(tbl.to_string(index=False, float_format=lambda v: f"{v:,.3f}"))

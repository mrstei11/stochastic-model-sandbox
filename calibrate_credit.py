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


def score(tbl: pd.DataFrame) -> float:
    """Squared distance from the target EL ladder (bps): the anchors say
    best sectors ~5-10, mid ~12-15, upper ~20-25, worst ~50 — so target the
    whole quantile shape, not just the endpoints (endpoint-only scoring let
    the floors flatten every sector into one cluster)."""
    q = tbl.EL_bps.quantile
    targets = {0.0: 7.5, 0.25: 10.0, 0.5: 14.0, 0.75: 22.0, 1.0: 50.0}
    return sum((q(p) - t) ** 2 for p, t in targets.items())


if __name__ == "__main__":
    grid = {
        "a0":          [-6.5, -6.0],
        "a1":          [1.5, 2.0],
        "a3":          [1.0, 1.5],
        "lgd_ongoing": [0.057],
        "edf_floor":   [0.003, 0.004, 0.005],
        "lgd_floor":   [0.10, 0.15],
        "mat_ltv_trigger": [1.05],
        "mat_cure":    [0.0, 0.20, 0.40],
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

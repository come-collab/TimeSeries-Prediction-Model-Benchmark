"""Build site/data.json from the local benchmark run and the public leaderboard files.

Inputs:
  results/benchmark/{run.json, metrics.csv, predictions.csv}   ← python benchmark.py
  results/leaderboards/{gift_eval,fev_bench}/                   ← scripts/fetch_leaderboards.sh
  data/ETTh1.csv                                                (history shown behind each forecast)

Leaderboard aggregation reproduces the public sites:
  GIFT-Eval  per-config MASE and CRPS / Seasonal_Naive, geometric mean over the 97 configs.
  fev-bench  official fev.leaderboard(): skill = 1 - gmean(clip(err / seasonal naive, .01, 100)),
             win rate over (task, opponent) pairs, ties = 1/2.

Usage: python build_site.py
"""
import json
import re
from pathlib import Path

import fev
import numpy as np
import pandas as pd
from scipy.stats import gmean

BENCH = Path("results/benchmark")
BOARDS = Path("results/leaderboards")
OUT = Path("site/data.json")
HISTORY = 168          # hours of history shown before each forecast in the explorer


def key(name):
    """Normalise model names across sources: 'TiRex-2-Zeroshot', 'tirex-2', 'Moirai-2.0', 'Moirai2'..."""
    k = re.sub(r"[^a-z0-9]", "", name.lower())
    return {"tirex2zeroshot": "tirex2", "moirai20": "moirai2", "seasonalnaive": "seasonalnaive"}.get(k, k)


def r(x, d=4):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), d)


# --- Local benchmark -----------------------------------------------------------------------------
run = json.loads((BENCH / "run.json").read_text())
metrics = pd.read_csv(BENCH / "metrics.csv", index_col="model")
pred = pd.read_csv(BENCH / "predictions.csv", parse_dates=["origin", "date"])
H = run["horizon"]
origins = pred["origin"].drop_duplicates().tolist()
W = len(origins)
actual = pred["actual"].to_numpy().reshape(W, H)

df = pd.read_csv("data/ETTh1.csv", parse_dates=["date"], index_col="date", usecols=["date", "OT"])
first = df.index.get_loc(origins[0]) - HISTORY
last = df.index.get_loc(origins[-1]) + H
series = {"start": df.index[first].isoformat(), "values": [r(v, 2) for v in df["OT"].iloc[first:last]]}

models, forecasts = [], {}
for name, meta in run["models"].items():
    q = {lv: pred[f"{name}|q{lv:02d}"].to_numpy().reshape(W, H) for lv in (10, 50, 90)}
    m = metrics.loc[name]
    models.append({
        "name": name, "key": key(name), "org": meta["org"], "params": meta["params"],
        "license": meta["license"], "repo": meta["repo"], "revision": meta["revision"],
        "local": {c: r(m[c]) for c in metrics.columns},
        "windowMae": [r(v, 3) for v in np.abs(q[50] - actual).mean(1)],
    })
    forecasts[name] = {f"q{lv}": [[r(v, 2) for v in row] for row in q[lv]] for lv in (10, 50, 90)}

# Pairwise local win rate (share of windows with lower MAE, ties 1/2)
wm = {m["name"]: np.array(m["windowMae"]) for m in models}
pairwise = {a: {b: r(np.mean((wm[a] < wm[b]) + 0.5 * (wm[a] == wm[b])), 3) for b in wm if b != a} for a in wm}

# --- GIFT-Eval -----------------------------------------------------------------------------------
gift_dirs = [d for d in (BOARDS / "gift_eval").iterdir() if (d / "all_results.csv").exists()]
gift = {d.name: pd.read_csv(d / "all_results.csv").set_index("dataset") for d in gift_dirs}
gift_cfg = {d.name: json.loads((d / "config.json").read_text()) for d in gift_dirs if (d / "config.json").exists()}
naive = gift.pop("Seasonal_Naive")
C_MASE, C_CRPS = "eval_metrics/MASE[0.5]", "eval_metrics/mean_weighted_sum_quantile_loss"
ett = [d for d in naive.index if d.lower().startswith("ett")]
gift_rows = []
for name, g in gift.items():
    g = g.loc[naive.index]
    cfg = gift_cfg.get(name, {})
    gift_rows.append({
        "name": name, "key": key(name), "org": cfg.get("org"), "type": cfg.get("model_type"),
        "leakage": cfg.get("testdata_leakage"),
        "mase": r(gmean(g[C_MASE] / naive[C_MASE])), "crps": r(gmean(g[C_CRPS] / naive[C_CRPS])),
        "ettMase": r(gmean(g.loc[ett, C_MASE] / naive.loc[ett, C_MASE])),
        "ettCrps": r(gmean(g.loc[ett, C_CRPS] / naive.loc[ett, C_CRPS])),
    })
gift_rows.sort(key=lambda x: x["crps"])

# --- fev-bench -----------------------------------------------------------------------------------
summaries = [pd.read_csv(f) for f in sorted((BOARDS / "fev_bench").glob("*.csv"))]
base = next(s["model_name"].iloc[0] for s in summaries if key(s["model_name"].iloc[0]) == "seasonalnaive")
fev_rows = {}
for metric in ("SQL", "MASE"):
    lb = fev.leaderboard(summaries, metric_column=metric, baseline_model=base)
    for name, row in lb.iterrows():
        if name == base:
            continue
        e = fev_rows.setdefault(name, {"name": name, "key": key(name)})
        e[f"skill{metric}"], e[f"win{metric}"] = r(row["skill_score"]), r(row["win_rate"])
allfev = pd.concat(summaries)
ett_sql = allfev[allfev["task_name"] == "ETT_1H"].set_index("model_name")["SQL"]
base_ett = ett_sql[base]
for name, e in fev_rows.items():
    e["ett1hSql"] = r(ett_sql.get(name, np.nan) / base_ett)
fev_list = sorted(fev_rows.values(), key=lambda x: -x["skillSQL"])

# Nicer display names for fev entries that are lower-case in the source files
display = {g["key"]: g["name"] for g in gift_rows} | {m["key"]: m["name"] for m in models}
for e in fev_list:
    e["name"] = display.get(e["key"], e["name"])

fetched = (BOARDS / "FETCHED").read_text().strip() if (BOARDS / "FETCHED").exists() else None
OUT.parent.mkdir(exist_ok=True)
OUT.write_text(json.dumps({
    "run": {k: run[k] for k in ("date", "dataset", "target", "horizon", "stride", "windows", "device", "gpu",
                                "test_split", "train_end", "quantiles")},
    "origins": [o.isoformat() for o in origins],
    "series": series, "history": HISTORY,
    "models": models, "forecasts": forecasts, "pairwise": pairwise,
    "leaderboards": {"fetched": fetched, "gift": gift_rows, "fev": fev_list,
                     "giftConfigs": int(len(naive)), "giftEttConfigs": len(ett),
                     "fevTasks": int(allfev["task_name"].nunique())},
}, separators=(",", ":")))
print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB): {len(models)} local models, "
      f"{len(gift_rows)} GIFT-Eval, {len(fev_list)} fev-bench entries")

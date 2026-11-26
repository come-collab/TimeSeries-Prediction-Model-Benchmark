"""Recompute the public leaderboard scores for Timestral vs TimeH2O from the official result files.

The raw per-task results were downloaded into results/leaderboards/ from:
  GIFT-Eval  https://github.com/SalesforceAIResearch/gift-eval/tree/main/results/<MODEL>/all_results.csv
  fev-bench  https://github.com/autogluon/fev/tree/main/benchmarks/fev_bench/results/<model>.csv

How each leaderboard aggregates (reproduced here):
  GIFT-Eval: 97 configs (dataset x frequency x short/medium/long term). Per config, MASE (median
    forecast) and CRPS (= mean weighted quantile loss over 0.1..0.9) are divided by the
    Seasonal_Naive score, then combined with a geometric mean across the 97 configs.
  fev-bench: 100 tasks, each with its own horizon / number of rolling windows. Per task the error
    (SQL = scaled quantile loss, or MASE) is divided by seasonal_naive, clipped to [0.01, 100];
    skill score = 1 - geometric mean of those ratios; win rate = share of (task, other model)
    pairs won, ties count half. Computed with the official `fev` package.

Usage: .venv/bin/python leaderboardComparison.py
"""
from pathlib import Path

import fev
import numpy as np
import pandas as pd
from scipy.stats import gmean

ROOT = Path("results/leaderboards")
PAIRS = [("Timestral-209M", "TimeH2O-v1"), ("Timestral-5M", "TimeH2O-v1-tiny")]
FEV_NAME = {"TimeH2O-v1": "timeh2o-v1", "TimeH2O-v1-tiny": "timeh2o-v1-tiny"}  # fev file naming

# --- GIFT-Eval -----------------------------------------------------------------------------------
gift = {m.name: pd.read_csv(m / "all_results.csv").set_index("dataset") for m in (ROOT / "gift_eval").iterdir()}
naive = gift["Seasonal_Naive"]
cols = {"MASE": "eval_metrics/MASE[0.5]", "CRPS": "eval_metrics/mean_weighted_sum_quantile_loss"}

print("=== GIFT-Eval (97 configs, lower is better; normalised by Seasonal_Naive, geometric mean) ===")
rows = {}
for name, df in gift.items():
    if name == "Seasonal_Naive":
        continue
    rows[name] = {k: gmean(df.loc[naive.index, c] / naive[c]) for k, c in cols.items()}
print(pd.DataFrame(rows).T.sort_values("CRPS").to_string(float_format=lambda x: f"{x:.4f}"))

for a, b in PAIRS:
    ca, cb = gift[a][cols["CRPS"]], gift[b][cols["CRPS"]]
    ma, mb = gift[a][cols["MASE"]], gift[b][cols["MASE"]]
    print(f"\n{a} vs {b}: {b} better on CRPS in {(cb < ca).sum()}/97 configs, "
          f"on MASE in {(mb < ma).sum()}/97")

# ETT rows on GIFT-Eval (ETT1 = ETTh1/ETTm1 family, all 7 variates jointly, not only OT).
ett = [d for d in naive.index if d.lower().startswith("ett")]
print("\nGIFT-Eval ETT configs (CRPS / MASE):")
ett_table = pd.DataFrame({m: gift[m].loc[ett, cols["CRPS"]] for p in PAIRS for m in p})
ett_table_mase = pd.DataFrame({m: gift[m].loc[ett, cols["MASE"]] for p in PAIRS for m in p})
print(ett_table.round(4).to_string())
print(ett_table_mase.round(4).to_string())

# --- fev-bench -----------------------------------------------------------------------------------
summaries = [pd.read_csv(f) for f in (ROOT / "fev_bench").glob("*.csv")]
print("\n=== fev-bench (100 tasks, official fev.leaderboard, baseline seasonal_naive) ===")
for metric in ["SQL", "MASE"]:
    lb = fev.leaderboard(summaries, metric_column=metric, baseline_model="Seasonal Naive")
    print(f"\n-- {metric} --  (win rate here is among only these {len(summaries)} models, "
          "so it differs from the site's)")
    print(lb[["skill_score", "win_rate"]].to_string(float_format=lambda x: f"{x:.4f}"))

for a, b in PAIRS:
    pc = fev.pairwise_comparison(summaries, metric_column="SQL", included_models=[FEV_NAME.get(a, a), FEV_NAME.get(b, b)],
                                 n_resamples=1000)
    print(f"\nHead-to-head on SQL with 95% bootstrap CI ({a} vs {b}):")
    print(pc.to_string(float_format=lambda x: f"{x:.4f}"))

all_fev = pd.concat(summaries)
ett_fev = all_fev[all_fev["task_name"].str.lower().str.startswith("ett")]
print("\nfev-bench ETT tasks (SQL, lower is better):")
print(ett_fev.pivot_table(index="task_name", columns="model_name", values="SQL").round(4).to_string())
print(ett_fev.groupby("task_name")[["horizon", "num_windows", "seasonality"]].first().to_string())

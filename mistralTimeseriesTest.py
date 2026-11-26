"""Basic zero-shot test of Mistral's Timestral on ETTh1 oil temperature (OT).

What it does:
  1. Loads OT from ETTh1 (hourly).
  2. Picks forecast origins inside the standard ETTh1 test split (last 4 months).
  3. For each origin, gives the model ALL history before it, asks for the next HORIZON hours.
  4. Compares the forecast with the real values (which the model never saw) and with two
     dumb baselines. If Timestral can't beat "repeat yesterday", something is off.
  5. Saves a CSV (every prediction next to the truth) and a plot so you can check by hand.
"""
import time

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import torch
from timestral import TimestralForecaster

MODEL = "mistralai/Timestral-209M"   # also cached: -5M, -28M, -123M
HORIZON = 96                         # hours to predict (standard ETT horizon)
N_WINDOWS = 10                       # number of forecast origins to test

# --- 1. Data -----------------------------------------------------------------
df = pd.read_csv("data/ETTh1.csv", parse_dates=["date"], index_col="date", usecols=["date", "OT"])
ot = df["OT"].to_numpy(dtype=np.float32)

# Standard ETTh1 split (Informer paper): 12 months train, 4 val, 4 test, 30 days * 24 h each.
test_start = 12 * 30 * 24 + 4 * 30 * 24   # = 11520
test_end = test_start + 4 * 30 * 24       # = 14400

# Non-overlapping origins spread over the test split.
origins = np.linspace(test_start, test_end - HORIZON, N_WINDOWS, dtype=int)
print(f"{len(ot)} hourly points, testing {N_WINDOWS} origins from {df.index[origins[0]]} "
      f"to {df.index[origins[-1]]}, horizon {HORIZON}h")

# --- 2. Model ----------------------------------------------------------------
device = "cuda" if torch.cuda.is_available() else "cpu"
forecaster = TimestralForecaster.from_pretrained(MODEL, device=device)

# --- 3. Forecast each window ------------------------------------------------
# Each origin has a different context length, so run them one by one (no padding tricks).
rows, results = [], []
t0 = time.time()
for o in origins:
    context = ot[:o]                                  # everything strictly before the origin
    truth = ot[o:o + HORIZON]
    fc = forecaster.forecast(context, prediction_length=HORIZON)
    median = fc.median.squeeze().cpu().numpy()        # (HORIZON,)
    q10 = fc.quantile(0.1).squeeze().cpu().numpy()
    q90 = fc.quantile(0.9).squeeze().cpu().numpy()

    naive_last = np.full(HORIZON, context[-1])        # repeat last value
    naive_seasonal = np.resize(context[-24:], HORIZON)  # repeat the last 24h

    results.append(dict(origin=o, truth=truth, median=median, q10=q10, q90=q90,
                        naive_last=naive_last, naive_seasonal=naive_seasonal))
    for h in range(HORIZON):
        rows.append(dict(origin=df.index[o], date=df.index[o + h], step=h + 1, actual=truth[h],
                         timestral=median[h], q10=q10[h], q90=q90[h],
                         naive_last=naive_last[h], naive_seasonal=naive_seasonal[h]))
print(f"forecasting took {time.time() - t0:.1f}s on {device}")

# --- 4. Metrics --------------------------------------------------------------
pred = pd.DataFrame(rows)
pred.to_csv("results/timestral_basic/timestral_ETTh1_OT_predictions.csv", index=False)

# Raw scale (degrees) and "standard" scale: z-normalised with train-split mean/std, which is
# how ETTh1 MSE/MAE numbers are usually reported in papers.
mu, sd = ot[:12 * 30 * 24].mean(), ot[:12 * 30 * 24].std()
print(f"\n{'method':<16}{'MAE (°C)':>10}{'RMSE (°C)':>11}{'MSE (norm)':>12}{'MAE (norm)':>12}")
for method in ["timestral", "naive_last", "naive_seasonal"]:
    err = pred[method] - pred["actual"]
    err_n = err / sd
    print(f"{method:<16}{err.abs().mean():>10.3f}{np.sqrt((err ** 2).mean()):>11.3f}"
          f"{(err_n ** 2).mean():>12.3f}{err_n.abs().mean():>12.3f}")

inside = ((pred["actual"] >= pred["q10"]) & (pred["actual"] <= pred["q90"])).mean()
print(f"\n80% interval (q10-q90) coverage: {inside:.1%} (well calibrated ≈ 80%)")
print("All predictions saved to results/timestral_basic/timestral_ETTh1_OT_predictions.csv")

# --- 5. Plot -----------------------------------------------------------------
fig, axes = plt.subplots(len(results), 1, figsize=(12, 2.6 * len(results)), sharex=False)
for ax, r in zip(np.atleast_1d(axes), results):
    o = r["origin"]
    hist_idx = df.index[o - 2 * HORIZON:o]
    fut_idx = df.index[o:o + HORIZON]
    ax.plot(hist_idx, ot[o - 2 * HORIZON:o], color="black", lw=1, label="history (model input)")
    ax.plot(fut_idx, r["truth"], color="black", lw=1, ls="--", label="actual (hidden)")
    ax.plot(fut_idx, r["median"], color="tab:blue", lw=1.5, label="Timestral median")
    ax.fill_between(fut_idx, r["q10"], r["q90"], color="tab:blue", alpha=0.2, label="q10–q90")
    ax.plot(fut_idx, r["naive_seasonal"], color="tab:orange", lw=1, alpha=0.7, label="repeat last 24h")
    mae = np.abs(r["median"] - r["truth"]).mean()
    ax.set_title(f"origin {df.index[o]}  —  Timestral MAE {mae:.2f} °C", fontsize=9)
    ax.set_ylabel("OT (°C)")
np.atleast_1d(axes)[0].legend(loc="upper left", fontsize=7, ncol=5)
fig.tight_layout()
fig.savefig("results/timestral_basic/timestral_ETTh1_OT_forecast.png", dpi=110)
print("Plot saved to results/timestral_basic/timestral_ETTh1_OT_forecast.png")

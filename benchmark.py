"""Local zero-shot benchmark of time-series foundation models on ETTh1 oil temperature (OT).

Every model is scored on the *identical* windows:
  - forecast origins every --stride hours across the standard ETTh1 test split (last 4 months),
  - each model gets the full history before the origin (< 14,400 steps, so no model truncates:
    Timestral reads up to 32,768, TimeH2O up to 16,384),
  - the next --horizon hours are hidden and used only for scoring.

Metrics (same code for every model):
  MAE / RMSE in °C, MSE / MAE on train-normalised scale (how ETTh1 papers report),
  MASE (MAE / in-sample seasonal-naive MAE, period 24), WQL over quantiles 0.1..0.9
  (the CRPS approximation GIFT-Eval uses), q10–q90 coverage, and win rate
  (share of (window, other model) pairs with a lower MAE, ties count half — as fev-bench does).

Outputs in results/benchmark/: metrics.csv, predictions.csv (every forecast next to the truth),
run.json (settings, model revisions, date). Then run build_site.py to refresh the website data.

TimeH2O models are gated on Hugging Face: accept the licence on the model pages and set HF_TOKEN
(or `hf auth login`) for the first download; weights are cached afterwards.

Usage:  python benchmark.py [--models all] [--stride 24] [--horizon 96]
"""
import argparse
import datetime as dt
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch

QUANTILES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]   # common to every model
MEDIAN = QUANTILES.index(0.5)
SEASON = 24                                                 # hourly data, daily cycle
OUT = Path("results/benchmark")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


# --- Model adapters: predict(context 1-D array, horizon) -> (horizon, 9) quantiles ---------------
def timestral(repo):
    def load():
        from timestral import TimestralForecaster
        m = TimestralForecaster.from_pretrained(repo, device=DEVICE)

        def predict(context, h):
            fc = m.forecast(context, prediction_length=h)
            return np.stack([fc.quantile(q).squeeze().cpu().numpy() for q in QUANTILES], axis=-1)
        return predict
    return load


def timeh2o(repo):
    def load():
        from h2ofm import TimeH2O
        m = TimeH2O.from_pretrained(repo, device=DEVICE)

        def predict(context, h):
            return np.asarray(m.forecast(context, horizon=h, quantile_levels=QUANTILES).quantiles,
                              dtype=np.float32)
        return predict
    return load


def seasonal_naive():
    def predict(context, h):
        return np.resize(context[-SEASON:], h)[:, None].repeat(len(QUANTILES), -1)
    return lambda: predict


# To add a model: write an adapter above and register it here.
MODELS = {
    "Timestral-209M": dict(load=timestral("mistralai/Timestral-209M"), repo="mistralai/Timestral-209M",
                           org="Mistral AI", params=209e6, license="Modified MIT (weights), Apache-2.0 (code)"),
    "Timestral-5M": dict(load=timestral("mistralai/Timestral-5M"), repo="mistralai/Timestral-5M",
                         org="Mistral AI", params=5.2e6, license="Modified MIT (weights), Apache-2.0 (code)"),
    "TimeH2O-v1": dict(load=timeh2o("h2oai/timeh2o-v1"), repo="h2oai/timeh2o-v1",
                       org="H2O.ai", params=108e6, license="H2O Model Non-Commercial Licence v1.0"),
    "TimeH2O-v1-tiny": dict(load=timeh2o("h2oai/timeh2o-v1-tiny"), repo="h2oai/timeh2o-v1-tiny",
                            org="H2O.ai", params=5.8e6, license="H2O Model Non-Commercial Licence v1.0"),
    "Seasonal naive": dict(load=seasonal_naive(), repo=None, org="Baseline", params=0,
                           license="—"),
}


def hub_revision(repo):
    """Commit hash of the cached Hub snapshot that was used (None for baselines)."""
    if repo is None:
        return None
    from huggingface_hub import scan_cache_dir
    for r in scan_cache_dir().repos:
        if r.repo_id == repo:
            return sorted(r.revisions, key=lambda x: x.last_modified)[-1].commit_hash
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", default="all", help="comma-separated names, or 'all'")
    parser.add_argument("--stride", type=int, default=24, help="hours between forecast origins")
    parser.add_argument("--horizon", type=int, default=96)
    args = parser.parse_args()
    names = list(MODELS) if args.models == "all" else [m.strip() for m in args.models.split(",")]
    H = args.horizon

    df = pd.read_csv("data/ETTh1.csv", parse_dates=["date"], index_col="date", usecols=["date", "OT"])
    ot = df["OT"].to_numpy(dtype=np.float32)
    train_end = 12 * 30 * 24
    test_start, test_end = train_end + 4 * 30 * 24, train_end + 8 * 30 * 24
    origins = np.arange(test_start, test_end - H + 1, args.stride)
    sd = ot[:train_end].std()
    print(f"ETTh1 OT: {len(origins)} windows of {H}h every {args.stride}h "
          f"({df.index[origins[0]]} → {df.index[origins[-1]]}), device {DEVICE}")

    truth = np.stack([ot[o:o + H] for o in origins])                    # (W, H)
    mase_scale = np.array([np.abs(ot[SEASON:o] - ot[:o - SEASON]).mean() for o in origins])

    preds, runtime = {}, {}
    for name in names:
        predict = MODELS[name]["load"]()
        t0 = time.time()
        preds[name] = np.stack([predict(ot[:o], H) for o in origins])   # (W, H, 9)
        runtime[name] = time.time() - t0
        print(f"  {name:<16} {runtime[name]:6.1f}s")

    # Metrics
    levels = np.array(QUANTILES)
    window_mae = {n: np.abs(q[..., MEDIAN] - truth).mean(1) for n, q in preds.items()}
    rows = {}
    for name, q in preds.items():
        err = q[..., MEDIAN] - truth
        diff = truth[..., None] - q
        pinball = np.maximum(levels * diff, (levels - 1) * diff)
        others = [o for o in preds if o != name]
        wins = [np.mean((window_mae[name] < window_mae[o]) + 0.5 * (window_mae[name] == window_mae[o]))
                for o in others]
        rows[name] = {
            "mae": np.abs(err).mean(), "rmse": np.sqrt((err ** 2).mean()),
            "mse_norm": ((err / sd) ** 2).mean(), "mae_norm": (np.abs(err) / sd).mean(),
            "mase": (window_mae[name] / mase_scale).mean(),
            "wql": 2 * pinball.sum(-1).mean() / len(QUANTILES) / np.abs(truth).mean(),
            "coverage80": ((truth >= q[..., 0]) & (truth <= q[..., -1])).mean(),
            "win_rate": np.mean(wins) if wins else np.nan,
            "seconds": runtime[name],
        }
    table = pd.DataFrame(rows).T.sort_values("mae")
    print("\n" + table.to_string(float_format=lambda x: f"{x:.3f}"))

    # Save
    OUT.mkdir(parents=True, exist_ok=True)
    table.rename_axis("model").to_csv(OUT / "metrics.csv")
    cols = {"origin": np.repeat(df.index[origins], H),
            "date": np.concatenate([df.index[o:o + H] for o in origins]),
            "step": np.tile(np.arange(1, H + 1), len(origins)),
            "actual": truth.ravel()}
    for name, q in preds.items():
        for i, lv in enumerate(QUANTILES):
            cols[f"{name}|q{int(lv * 100):02d}"] = q[..., i].ravel()
    pd.DataFrame(cols).to_csv(OUT / "predictions.csv", index=False, float_format="%.4f")
    run = {
        "date": dt.date.today().isoformat(), "dataset": "ETTh1", "target": "OT", "horizon": H,
        "stride": args.stride, "windows": len(origins), "device": DEVICE,
        "gpu": torch.cuda.get_device_name(0) if DEVICE == "cuda" else None,
        "test_split": [int(test_start), int(test_end)], "train_end": int(train_end),
        "quantiles": QUANTILES,
        "models": {n: {k: v for k, v in MODELS[n].items() if k != "load"} | {"revision": hub_revision(MODELS[n]["repo"])}
                   for n in names},
    }
    (OUT / "run.json").write_text(json.dumps(run, indent=2))
    print(f"\nSaved to {OUT}/ — now run: python build_site.py")


if __name__ == "__main__":
    main()

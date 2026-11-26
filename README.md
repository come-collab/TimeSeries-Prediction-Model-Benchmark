# TimeSeries Prediction Model Benchmark

A local, verifiable benchmark of zero-shot time-series foundation models, and the website that shows its results
(**benchmark.cometrisse.com**).

Currently tested: Timestral-209M and Timestral-5M (Mistral AI), TimeH2O-v1 and TimeH2O-v1-tiny (H2O.ai), and a
seasonal-naive baseline. The task is forecasting ETTh1 oil temperature (`OT`, hourly, univariate).

## Repository layout

| path | what it is |
|---|---|
| `benchmark.py` | Runs every registered model on the same windows and writes `results/benchmark/` (metrics, every forecast next to the truth, run settings and model revisions) |
| `build_site.py` | Turns the results and the public leaderboard files into `site/data.json` |
| `scripts/fetch_leaderboards.sh` | Downloads the official per-task results of GIFT-Eval and fev-bench into `results/leaderboards/` |
| `leaderboardComparison.py` | Prints the GIFT-Eval / fev-bench comparison of the tested models in the terminal |
| `mistralTimeseriesTest.py` | The first basic test: Timestral-209M on 10 windows, with plot → `results/timestral_basic/` |
| `site/` | Static website (plain HTML/CSS/JS, no build step) |
| `Dockerfile`, `nginx.conf` | Container that serves `site/` (used by Coolify) |

## Run it locally

```bash
scripts/setup.sh                       # .venv + packages + ETT data in data/
export HF_TOKEN=hf_...                 # first run only: TimeH2O weights are gated (accept the licence on HF first)
.venv/bin/python benchmark.py          # all models; or --models "Timestral-209M,TimeH2O-v1"
scripts/fetch_leaderboards.sh          # refresh public leaderboard files
.venv/bin/python build_site.py         # refresh site/data.json
cd site && python3 -m http.server 8000 # preview at http://localhost:8000
```

To add a model, write a small adapter in `benchmark.py` that returns the 0.1…0.9 quantiles for a context array,
register it in `MODELS`, rerun the three commands above, and commit.

## Protocol (ETTh1 OT)

- Split: the standard Informer split (12 / 4 / 4 months of 30 days). Forecasts start in the test part, hours `[11520, 14400)`.
- Windows: a 96 h forecast every 24 h, giving 117 windows. Each model gets the full history before the window.
  No model truncates it: Timestral reads up to 32,768 steps, TimeH2O up to 16,384.
- Metrics:
  - MAE and RMSE in °C.
  - MSE and MAE normalised by the train-split mean and standard deviation (the scale ETTh1 papers use).
  - MASE, with a seasonality of 24.
  - WQL over the quantiles 0.1…0.9 (the CRPS approximation used by GIFT-Eval).
  - Coverage of the 10–90% range.
  - Pairwise win rate, with ties counting half.

## Results (run 2026-11-26, GTX 1070 Ti)

| model | MAE °C | MSE norm | MASE | WQL | cov 80% |
|---|---|---|---|---|---|
| TimeH2O-v1 | 1.462 | 0.045 | 0.633 | 0.236 | 85.0% |
| Timestral-209M | 1.478 | 0.046 | 0.640 | 0.237 | 83.9% |
| TimeH2O-v1-tiny | 1.533 | 0.049 | 0.663 | 0.246 | 86.0% |
| Timestral-5M | 1.571 | 0.052 | 0.680 | 0.249 | 82.0% |
| Seasonal naive | 1.933 | 0.071 | 0.836 | 0.389 | – |

## Deploy (Coolify)

Create a new resource from this Git repository and set:

- Build Pack: **Dockerfile**
- Port: **80**
- Domain: `https://benchmark.cometrisse.com`

Point the domain's DNS A record at the Coolify server. The site is fully static: results are computed locally and
committed in `site/data.json`, so a redeploy only copies files.

## Licences

- Code: see the individual files. Timestral code is Apache-2.0 and its weights use a Modified MIT licence.
- TimeH2O weights use the **H2O Model Non-Commercial Licence v1.0**. Benchmarking is allowed. Published results must
  give the model and version, the evaluation date, and the method; this README and the site's methodology section do
  that. The weights must not be redistributed, so they are never committed.
- The ETT data (Zhou et al., Informer, AAAI 2021) is licensed CC BY-ND 4.0. It is downloaded by `scripts/setup.sh`
  rather than committed.

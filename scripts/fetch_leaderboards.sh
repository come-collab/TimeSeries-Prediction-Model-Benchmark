#!/usr/bin/env bash
# Download the official per-task results of the public leaderboards into results/leaderboards/.
#   GIFT-Eval: github.com/SalesforceAIResearch/gift-eval/tree/main/results
#   fev-bench: github.com/autogluon/fev/tree/main/benchmarks/fev_bench/results
# Edit the two lists to add models (names as they appear in those folders).
set -euo pipefail
cd "$(dirname "$0")/../results/leaderboards"

GIFT="Timestral-209M TimeH2O-v1 Timestral-5M TimeH2O-v1-tiny Seasonal_Naive Chronos-2 TimesFM-3 t0-gamma TiRex-2-Zeroshot Moirai2 Toto-2.0-313m"
FEV="timestral-209m timeh2o-v1 timestral-5m timeh2o-v1-tiny seasonal_naive chronos-2 timesfm-3 t0-gamma tirex-2 moirai-2_0 toto-2_0-313m"

for m in $GIFT; do
  mkdir -p "gift_eval/$m"
  for f in all_results.csv config.json; do
    curl -sfL "https://raw.githubusercontent.com/SalesforceAIResearch/gift-eval/main/results/${m// /%20}/$f" -o "gift_eval/$m/$f" \
      || echo "missing GIFT-Eval $m/$f"
  done
done
mkdir -p fev_bench
for m in $FEV; do
  curl -sfL "https://raw.githubusercontent.com/autogluon/fev/main/benchmarks/fev_bench/results/$m.csv" -o "fev_bench/$m.csv" \
    || echo "missing fev-bench $m"
done
echo "fetched on $(date -u +%F)" > FETCHED

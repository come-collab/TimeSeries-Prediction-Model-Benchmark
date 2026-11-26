#!/usr/bin/env bash
# One-time local setup: virtualenv, packages, ETT data.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v uv >/dev/null; then
  [ -d .venv ] || uv venv .venv
  uv pip install --python .venv/bin/python -r requirements.txt
else
  [ -d .venv ] || python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

# ETT dataset (Zhou et al., CC BY-ND 4.0) from the official repository.
mkdir -p data
for f in ETTh1 ETTh2 ETTm1 ETTm2; do
  [ -f "data/$f.csv" ] || curl -sfL "https://raw.githubusercontent.com/zhouhaoyi/ETDataset/main/ETT-small/$f.csv" -o "data/$f.csv"
done
echo "Setup done. TimeH2O weights are gated: accept the licence on huggingface.co/h2oai/timeh2o-v1 and export HF_TOKEN before the first benchmark run."

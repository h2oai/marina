#!/bin/bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# Download revision-pinned public agent-safety corpora and normalize them with
# DefenseClaw's normalizers (github.com/cisco-ai-defense/defenseclaw, Apache-2.0)
# into case-v1 JSONL under a LOCAL cache — never into this repository. Then:
#
#   bun run scripts/decision-cases/import-public.ts
#
# Needs git, python3 (3.11+) and ~1.7 GB of disk. Nothing from a dataset is
# executed. Every source below is approved in DefenseClaw's datasets.lock.json
# (MIT / Apache-2.0 / CC-BY-4.0, download-only); the non-commercial source there
# is deliberately not fetched.
set -euo pipefail

CACHE="${MARINA_DECISION_CASES_CACHE:-$HOME/.cache/marina/decision-cases}"
DEFENSECLAW_REV=d2ae73f32736db0aa9fd8e78d5656355c1a41012
mkdir -p "$CACHE/src" "$CACHE/out"
cd "$CACHE"

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q pyarrow jsonschema huggingface_hub
fi
PY="$CACHE/.venv/bin/python"

if [ ! -d defenseclaw/benchmarks ]; then
  rm -rf defenseclaw
  git clone -q --filter=blob:none --no-checkout https://github.com/cisco-ai-defense/defenseclaw.git defenseclaw
  git -C defenseclaw sparse-checkout set --cone benchmarks
fi
git -C defenseclaw checkout -q "$DEFENSECLAW_REV"

# name  git-url  revision
while read -r name url rev; do
  [ -d "src/$name/.git" ] || git clone -q "$url" "src/$name"
  git -C "src/$name" checkout -q "$rev"
done <<'GIT'
agentdojo https://github.com/ethz-spylab/agentdojo.git 089ed468cf3ed0322acc66b0211f26d9d90dbf60
injecagent https://github.com/uiuc-kang-lab/InjecAgent.git f19c9f2c79a41046eb13c03c51a24c567a8ffa07
quadrat https://github.com/mihail-gribov/quadrat-ipi-model-eval 03e496ba1af2baee5b54373f582a6752d3f2079f
GIT

"$PY" - "$CACHE/src" <<'HF'
import sys
from huggingface_hub import snapshot_download
root = sys.argv[1]
for name, repo, rev in [
    ("sentinel-flow", "ihabler/sentinel-flow", "f3b8d86ab1b2c8bfd99648478110b218c064ceaf"),
    ("agenthazard", "Yunhao-Feng/AgentHazard", "786147ad768f924608697cdcca87c367379b11ee"),
]:
    snapshot_download(repo_id=repo, repo_type="dataset", revision=rev, local_dir=f"{root}/{name}")
HF

cd defenseclaw
run() {
  local name=$1; shift
  "$PY" -m "benchmarks.scripts.benchmark_normalize_$name" "$@" \
    --output "$CACHE/out/$name.jsonl" --manifest "$CACHE/out/$name.manifest.json" > "$CACHE/out/$name.log" 2>&1
  echo "$name: $(wc -l < "$CACHE/out/$name.jsonl") cases"
}
run sentinel_flow --input "$CACHE/src/sentinel-flow/traces.jsonl"
run injecagent --input "$CACHE/src/injecagent/data/test_cases_dh_base.json" \
  --input "$CACHE/src/injecagent/data/test_cases_ds_base.json" --revision f19c9f2c79a41046eb13c03c51a24c567a8ffa07
run agentdojo --input-dir "$CACHE/src/agentdojo" --revision 089ed468cf3ed0322acc66b0211f26d9d90dbf60
run quadrat_ipi_model_eval --input-dir "$CACHE/src/quadrat" --revision 03e496ba1af2baee5b54373f582a6752d3f2079f
run agenthazard --input-dir "$CACHE/src/agenthazard" --revision 786147ad768f924608697cdcca87c367379b11ee
echo "normalized → $CACHE/out"

#!/usr/bin/env bash
# Launch the synthesis-provider with explicit env. Separate script so the
# main Bash tool can invoke it cleanly and setsid/nohup keep the process
# alive after the invoking shell exits.
#
# Environment (pass these IN from the caller, not hardcoded here):
#   AGENT_NAME            (default SynthesisProvider)
#   SYNTH_COUNCIL         (default marina:haiku,marina:qwen,marina:kimi,marina:gemma)
#   SYNTH_STRONG          (default marina:gemini)
#   SYNTH_ESCALATE_T      (default 0.75)
#   TRANSLATOR_CHANNEL    (REQUIRED — choose any translator-<name>, or "" for none)
#   SYNTH_TRACE           (default false)
#
# Usage:
#   TRANSLATOR_CHANNEL=translator-sonnet ./benchmarks/launch-synthesis.sh
#   TRANSLATOR_CHANNEL=translator-gemini SYNTH_STRONG=marina:sonnet ./benchmarks/launch-synthesis.sh

set -euo pipefail
cd "$(dirname "$0")/.."

pkill -f "sdk/examples/synthesis-provider.ts" 2>/dev/null || true
sleep 2

exec env \
  AGENT_NAME="${AGENT_NAME:-SynthesisProvider}" \
  SYNTH_COUNCIL="${SYNTH_COUNCIL:-marina:haiku,marina:qwen,marina:kimi,marina:gemma}" \
  SYNTH_STRONG="${SYNTH_STRONG:-marina:gemini}" \
  SYNTH_ESCALATE_T="${SYNTH_ESCALATE_T:-0.75}" \
  TRANSLATOR_CHANNEL="${TRANSLATOR_CHANNEL:-}" \
  SYNTH_TRACE="${SYNTH_TRACE:-false}" \
  bun run src/sdk/examples/synthesis-provider.ts

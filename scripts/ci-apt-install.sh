#!/usr/bin/env bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# CI package install: only the named packages (no recommends), bounded
# network timeouts, and up to three bounded attempts, so a slow Ubuntu
# mirror fails or recovers in minutes instead of exhausting the job timeout.
#
#   scripts/ci-apt-install.sh <package>...

set -euo pipefail

[ "$#" -gt 0 ] || { echo "usage: $0 <package>..." >&2; exit 2; }

ATTEMPT_SECONDS="${CI_APT_ATTEMPT_SECONDS:-180}"
# Runs as root under `timeout`; the packages arrive as positional arguments.
INSTALL='
  opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
  apt-get "${opts[@]}" update -qq &&
    DEBIAN_FRONTEND=noninteractive apt-get "${opts[@]}" install -y -qq --no-install-recommends "$@"
'

for attempt in 1 2 3; do
  if timeout "$ATTEMPT_SECONDS" sudo bash -c "$INSTALL" ci-apt-install "$@"; then
    exit 0
  fi
  echo "::warning::apt install attempt $attempt of 3 failed or timed out" >&2
done
echo "::error::apt install failed after 3 attempts: $*" >&2
exit 1

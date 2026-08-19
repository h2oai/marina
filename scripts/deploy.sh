#!/usr/bin/env bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${MARINA_IMAGE:?MARINA_IMAGE must be set to the ECR image ref to deploy}"
AWS_REGION="${AWS_REGION:-us-east-1}"
export MARINA_IMAGE AWS_REGION

echo "[deploy] host=$(hostname) image=${MARINA_IMAGE} at=$(date -u +%FT%TZ)"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "[deploy] ERROR: neither 'docker compose' nor 'docker-compose' is available" >&2
  exit 1
fi
echo "[deploy] using: $DC"

# Authenticate to ECR (registry host = everything before the first '/').
REGISTRY="${MARINA_IMAGE%%/*}"
echo "[deploy] logging in to ECR: ${REGISTRY}"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

echo "[deploy] pulling image"
$DC pull

echo "[deploy] (re)starting stack"
$DC up -d --remove-orphans

echo "[deploy] pruning dangling images"
docker image prune -f

echo "[deploy] current state:"
$DC ps
echo "[deploy] done."

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

# Free space (in whole GB) available on the filesystem that holds the Docker /
# containerd image store. Image layers are extracted here during a pull; if it
# fills up the pull stalls, the SSM document-worker hits its execution ceiling
# and is killed with an opaque "ipc messaging received timeout signal".
free_gb() { df -BG --output=avail / | tail -1 | tr -dc '0-9'; }

# Reclaim every image not used by a running container, plus build cache. The
# `-a` is load-bearing: a bare `docker image prune -f` only removes dangling
# (<none>) layers and leaves the tagged sha-<...> ECR images behind; old
# images then accumulate across deploys and can fill the disk.
reclaim() {
  echo "[deploy] reclaiming unused images and build cache"
  docker image prune -af || true
  docker builder prune -f || true
}

# --- pre-pull disk guard ---------------------------------------------------
# Require a floor of free space before pulling; if we are under it, reclaim
# first and re-check, and abort with a clear error rather than stalling.
MIN_FREE_GB="${MARINA_DEPLOY_MIN_FREE_GB:-20}"
echo "[deploy] free on /: $(free_gb)G (floor ${MIN_FREE_GB}G)"
if [ "$(free_gb)" -lt "$MIN_FREE_GB" ]; then
  reclaim
  echo "[deploy] free on /: $(free_gb)G after reclaim"
fi
if [ "$(free_gb)" -lt "$MIN_FREE_GB" ]; then
  echo "[deploy] ERROR: only $(free_gb)G free on / (need ${MIN_FREE_GB}G) after reclaim; aborting before pull" >&2
  exit 1
fi

# Authenticate to ECR (registry host = everything before the first '/').
REGISTRY="${MARINA_IMAGE%%/*}"
echo "[deploy] logging in to ECR: ${REGISTRY}"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

echo "[deploy] pulling image"
$DC pull

# --- configuration preflight ------------------------------------------------
# Run the new image's boot checks against this host's configuration (.env and
# compose environment) without a database or ports. A configuration the new
# code refuses stops here and the running stack keeps serving.
echo "[deploy] checking this configuration against the new image"
if ! $DC run --rm --no-deps -T marina bun run src/main.ts --check-config; then
  echo "[deploy] ERROR: the new image refuses this host's configuration (see the FATAL message above); the running stack was left unchanged" >&2
  exit 1
fi

# --- pin the deployed image for later bare compose commands -----------------
# compose resolves the service as `image: ${MARINA_IMAGE:-marina:local}` with
# `build: .`, and MARINA_IMAGE normally lives only in this script's environment.
# So a plain `docker compose up` run by hand on the host — during an incident,
# say — finds it unset, falls back to marina:local and BUILDS from whatever the
# working tree happens to be, silently replacing the deployed artifact.
# Recording it in .env makes a bare `up` reuse this exact digest instead. The
# deploy still exports MARINA_IMAGE, and an explicit value on the command line
# still wins, so this only changes the no-variable case.
# Written by truncating in place (`cat > .env`) rather than `sed -i`, which
# would replace the file and leave it owned by whoever ran the deploy.
persist_image_ref() {
  local line="MARINA_IMAGE=${MARINA_IMAGE}" tmp
  if [ ! -e .env ]; then
    (umask 077; printf '%s\n' "$line" > .env)
    echo "[deploy] recorded the deployed image in a new .env"
    return
  fi
  tmp="$(mktemp)"
  if grep -q '^MARINA_IMAGE=' .env; then
    sed "s|^MARINA_IMAGE=.*|${line}|" .env > "$tmp"
  else
    cat .env > "$tmp"
    [ -s "$tmp" ] && [ "$(tail -c1 "$tmp" | wc -l)" -eq 0 ] && printf '\n' >> "$tmp"
    printf '%s\n' "$line" >> "$tmp"
  fi
  cat "$tmp" > .env
  rm -f "$tmp"
  echo "[deploy] recorded the deployed image in .env"
}
persist_image_ref

echo "[deploy] (re)starting stack"
$DC up -d --wait --wait-timeout 180 --remove-orphans

echo "[deploy] checking running HTTP endpoints and configured providers"
$DC exec -T marina bun run scripts/smoke-production.ts --providers --output /tmp/marina-production-smoke.json

# --- post-deploy reclaim ---------------------------------------------------
# The new container is up and healthy, so the previous image is now unused.
# Prune it (and the rest of the tagged backlog) so the store stays bounded.
# `|| true` inside reclaim() keeps a prune hiccup from failing a good deploy.
reclaim

echo "[deploy] current state:"
$DC ps
echo "[deploy] done."

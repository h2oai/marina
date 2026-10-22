#!/usr/bin/env bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# CI package install: only the named packages (no recommends), bounded
# network timeouts, and up to three bounded attempts, so a slow Ubuntu
# mirror fails or recovers in minutes instead of exhausting the job timeout.
# Attempts after the first move off the runner's regional mirror list (for
# example azure.archive.ubuntu.com via mirror+file:) to archive.ubuntu.com.
#
# With CI_APT_CACHE_DIR set (a directory restored by actions/cache), cached
# .deb files are reused and newly downloaded ones are saved back, so most
# runs download nothing.
#
#   scripts/ci-apt-install.sh <package>...

set -euo pipefail

[ "$#" -gt 0 ] || { echo "usage: $0 <package>..." >&2; exit 2; }

ATTEMPT_SECONDS="${CI_APT_ATTEMPT_SECONDS:-180}"
# Runs as root under `timeout`; the packages arrive as positional arguments.
INSTALL='
  opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
  apt-get "${opts[@]}" update &&
    DEBIAN_FRONTEND=noninteractive apt-get "${opts[@]}" install -y -q --no-install-recommends "$@"
'

use_main_archive() {
  local f
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [ -f "$f" ] || continue
    sudo sed -i -E \
      -e 's#mirror\+file:/etc/apt/apt-mirrors\.txt#http://archive.ubuntu.com/ubuntu/#g' \
      -e 's#https?://[a-z0-9.-]+\.archive\.ubuntu\.com/ubuntu#http://archive.ubuntu.com/ubuntu#g' "$f"
  done
}

CACHE="${CI_APT_CACHE_DIR:-}"
if [ -n "$CACHE" ]; then
  mkdir -p "$CACHE"
  if compgen -G "$CACHE/*.deb" >/dev/null; then sudo cp "$CACHE"/*.deb /var/cache/apt/archives/; fi
fi
save_cache() {
  if [ -n "$CACHE" ] && compgen -G "/var/cache/apt/archives/*.deb" >/dev/null; then
    cp -u /var/cache/apt/archives/*.deb "$CACHE"/
  fi
}

for attempt in 1 2 3; do
  if [ "$attempt" -gt 1 ]; then use_main_archive; fi
  if timeout "$ATTEMPT_SECONDS" sudo bash -c "$INSTALL" ci-apt-install "$@"; then
    save_cache
    exit 0
  fi
  echo "::warning::apt install attempt $attempt of 3 failed or timed out" >&2
done
echo "::error::apt install failed after 3 attempts: $*" >&2
exit 1

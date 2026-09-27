#!/bin/bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
# Verified WAL-safe snapshots, retaining ten verified backups of this source.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
exec bun "$SCRIPT_DIR/backup.ts" backup "${1:-${DB_PATH:-marina.db}}" "${2:-backups}"

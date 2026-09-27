#!/bin/bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
# Restore to a NEW path; never replace a running or existing database.
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo "Usage: $0 BACKUP_FILE NEW_DB_PATH" >&2
  exit 1
fi
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
exec bun "$SCRIPT_DIR/backup.ts" restore "$1" "$2"

#!/bin/bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0

# Marina State Import
# Usage: ./scripts/import.sh <snapshot.json> [db_path] [--merge] [--skip-events]
#
# Imports an Marina state snapshot into a database.
# Without --merge, all existing data is replaced.
# Stop the server before importing.

set -euo pipefail

cd "$(dirname "$0")/.."
exec bun scripts/state-import.ts "$@"

#!/bin/bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0

# Marina State Export
# Usage: ./scripts/export.sh [db_path] [output_path] [--skip-events] [--include-secrets]
#
# Exports logical tables to a private portable JSON file (no binary assets/workspaces).
# Import into a compatible schema. Credential omission does not make content public.

set -euo pipefail

cd "$(dirname "$0")/.."
exec bun scripts/state-export.ts "$@"

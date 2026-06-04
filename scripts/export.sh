#!/bin/bash
# Marina State Export
# Usage: ./scripts/export.sh [db_path] [output_path] [--skip-events] [--skip-connectors]
#
# Exports the entire Marina instance state to a portable JSON file.
# This file can be imported into any other Marina instance.

set -euo pipefail

cd "$(dirname "$0")/.."
exec bun scripts/state-export.ts "$@"

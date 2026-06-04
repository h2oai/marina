#!/bin/bash
# Marina Database Restore Script
# Usage: ./scripts/restore.sh <backup_file> [db_path]

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <backup_file> [db_path]"
  echo ""
  echo "Available backups:"
  ls -lh backups/marina_*.db 2>/dev/null || echo "  (none found in backups/)"
  exit 1
fi

BACKUP_FILE="$1"
DB_PATH="${2:-${DB_PATH:-marina.db}}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Backup file not found: $BACKUP_FILE"
  exit 1
fi

# Safety: back up current DB before restoring
if [ -f "$DB_PATH" ]; then
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  cp "$DB_PATH" "${DB_PATH}.pre-restore.${TIMESTAMP}"
  echo "Current DB backed up to: ${DB_PATH}.pre-restore.${TIMESTAMP}"
fi

# Remove WAL/SHM files (they'll be recreated)
rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"

# Restore
cp "$BACKUP_FILE" "$DB_PATH"

echo "Restored: $BACKUP_FILE -> $DB_PATH"
echo "Size: $(du -h "$DB_PATH" | cut -f1)"
echo ""
echo "Restart the Marina server to use the restored database."

#!/bin/bash
# Marina Database Backup Script
# Usage: ./scripts/backup.sh [db_path] [backup_dir]

set -euo pipefail

DB_PATH="${1:-${DB_PATH:-marina.db}}"
BACKUP_DIR="${2:-backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/marina_${TIMESTAMP}.db"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Use SQLite's .backup for a consistent backup (safe with WAL mode)
if command -v sqlite3 &> /dev/null; then
  sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"
else
  # Fallback: copy with checkpoint
  cp "$DB_PATH" "$BACKUP_FILE"
fi

echo "Backup created: $BACKUP_FILE"
echo "Size: $(du -h "$BACKUP_FILE" | cut -f1)"

# Optional: upload to S3
if [ -n "${S3_BUCKET:-}" ]; then
  if command -v aws &> /dev/null; then
    aws s3 cp "$BACKUP_FILE" "s3://${S3_BUCKET}/marina/${TIMESTAMP}.db"
    echo "Uploaded to s3://${S3_BUCKET}/marina/${TIMESTAMP}.db"
  else
    echo "Warning: aws CLI not found, skipping S3 upload"
  fi
fi

# Clean up old local backups (keep last 10)
ls -t "${BACKUP_DIR}"/marina_*.db 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true

echo "Backup complete."

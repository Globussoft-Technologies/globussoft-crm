#!/bin/bash
set -e
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$SCRIPT_DIR/.."
BACKUP_DIR="$ROOT_DIR/backups"
mkdir -p "$BACKUP_DIR"

# Parse DATABASE_URL (format: mysql://user:pass@host:port/dbname)
source <(grep -E "^DATABASE_URL=" "$ROOT_DIR/.env" | sed 's/DATABASE_URL=/export DATABASE_URL=/' | sed 's/"//g')

# Extract connection parts (use sed to parse the URL)
DB_USER=$(echo "$DATABASE_URL" | sed -n 's|mysql://\([^:]*\):.*|\1|p')
DB_PASS=$(echo "$DATABASE_URL" | sed -n 's|mysql://[^:]*:\([^@]*\)@.*|\1|p')
DB_HOST=$(echo "$DATABASE_URL" | sed -n 's|mysql://[^:]*:[^@]*@\([^:]*\):.*|\1|p')
DB_PORT=$(echo "$DATABASE_URL" | sed -n 's|mysql://[^:]*:[^@]*@[^:]*:\([0-9]*\)/.*|\1|p')
DB_NAME=$(echo "$DATABASE_URL" | sed -n 's|.*/\([^?]*\).*|\1|p')

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/backup-$TIMESTAMP.sql.gz"

echo "Backing up $DB_NAME to $BACKUP_FILE..."
mysqldump -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" --single-transaction --quick "$DB_NAME" | gzip > "$BACKUP_FILE"

# Cleanup: keep only last 30 days
find "$BACKUP_DIR" -name "backup-*.sql.gz" -mtime +30 -delete

echo "Backup complete: $BACKUP_FILE ($(du -h $BACKUP_FILE | cut -f1))"

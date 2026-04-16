#!/bin/bash
set -e
if [ -z "$1" ]; then
  echo "Usage: ./restore.sh <backup-file.sql.gz>"
  exit 1
fi

ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
source <(grep -E "^DATABASE_URL=" "$ROOT_DIR/.env" | sed 's/DATABASE_URL=/export DATABASE_URL=/' | sed 's/"//g')

DB_USER=$(echo "$DATABASE_URL" | sed -n 's|mysql://\([^:]*\):.*|\1|p')
DB_PASS=$(echo "$DATABASE_URL" | sed -n 's|mysql://[^:]*:\([^@]*\)@.*|\1|p')
DB_HOST=$(echo "$DATABASE_URL" | sed -n 's|mysql://[^:]*:[^@]*@\([^:]*\):.*|\1|p')
DB_PORT=$(echo "$DATABASE_URL" | sed -n 's|mysql://[^:]*:[^@]*@[^:]*:\([0-9]*\)/.*|\1|p')
DB_NAME=$(echo "$DATABASE_URL" | sed -n 's|.*/\([^?]*\).*|\1|p')

echo "Restoring $1 to $DB_NAME..."
read -p "Are you sure? This will OVERWRITE the database. Type 'yes' to continue: " confirm
[ "$confirm" = "yes" ] || exit 1

gunzip -c "$1" | mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME"
echo "Restore complete."

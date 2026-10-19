#!/usr/bin/env bash
# Destructive, opt-in reset scoped to the two Generic 2.0 external volumes.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "WARNING: This permanently deletes ALL Generic 2.0 database records and uploaded files."
echo "Volumes: gbscrm_generic_v2_database and gbscrm_generic_v2_uploads"
echo "There is no undo without a separate backup. Other projects are not targeted."
read -r -p 'Type DELETE GENERIC V2 DATA to continue: ' confirmation
if [[ "$confirmation" != "DELETE GENERIC V2 DATA" ]]; then
  echo "Cancelled. Nothing stopped or deleted."
  exit 1
fi

docker compose -f docker-compose.generic-v2.yml down
for volume in gbscrm_generic_v2_database gbscrm_generic_v2_uploads; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    # No --force: refuse removal if another container is still using the volume.
    docker volume rm "$volume"
  else
    echo "Volume not found: $volume (no deletion needed)."
  fi
done
echo "Generic 2.0 stopped and its database/upload volumes deleted. Recovery requires a backup."

#!/usr/bin/env bash
# Stop/remove this stack's containers and network, retaining both external volumes.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
docker compose -f docker-compose.generic-v2.yml down
echo "Generic 2.0 stopped. Database and uploads are preserved."

#!/usr/bin/env bash
# One-command Compose startup, including the runtime-generated public origin.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
COMPOSE=(docker compose -f docker-compose.generic-v2.yml)

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop, then run this command again." >&2
  exit 1
fi

# Idempotent: creating an existing volume does not erase its contents.
docker volume create gbscrm_generic_v2_database >/dev/null
docker volume create gbscrm_generic_v2_uploads >/dev/null
"${COMPOSE[@]}" up --build -d

echo "Waiting for Cloudflare to generate the public testing URL..."
tunnel_id="$("${COMPOSE[@]}" ps -q cloudflared)"
if [[ -z "$tunnel_id" ]]; then
  echo "Cloudflare container did not start. Check Compose logs." >&2
  exit 1
fi
tunnel_started="$(docker inspect --format '{{.State.StartedAt}}' "$tunnel_id")"
tunnel_url=""
for ((attempt = 0; attempt < 90; attempt++)); do
  tunnel_url="$(docker logs --since "$tunnel_started" "$tunnel_id" 2>&1 |
    sed -nE 's/.*(https:\/\/[a-z0-9-]+\.trycloudflare\.com).*/\1/p' | tail -n 1)"
  if [[ -n "$tunnel_url" ]]; then
    break
  fi
  sleep 2
done

if [[ -z "$tunnel_url" ]]; then
  echo "No tunnel URL received within 180 seconds. Containers remain running." >&2
  echo "Inspect: docker compose -f docker-compose.generic-v2.yml logs cloudflared" >&2
  exit 1
fi

# Compose cannot interpolate an as-yet-unknown tunnel URL during initial startup.
# Reconfigure only the backend, keeping the tunnel and volumes untouched.
export GENERIC_V2_TUNNEL_ORIGIN="$tunnel_url"
"${COMPOSE[@]}" up -d --no-deps --wait backend

printf '\nGeneric 2.0 is ready.\nLocal:  http://localhost:5174\nPublic: %s\n' "$tunnel_url"
echo "Use test data only. The public URL may change after a tunnel restart."
echo "Existing database data is preserved; this command NEVER runs the destructive seed script."

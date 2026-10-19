# Generic 2.0 persistent local Docker stack

This standalone Compose file runs the current checkout without changing the
existing local/demo stacks. Docker Desktop must be running. It uses a separate
database; it does not copy data from another environment.

The Docker builds use Node 24. The backend uses Debian with Python, native
canvas build dependencies and system Chromium so Apple Silicon/ARM64 builds
do not depend on unavailable Alpine canvas binaries or Chrome downloads.
The first build downloads these packages and can take several minutes.

## First start

For a single command that creates the volumes, builds/starts Compose, waits for
the public tunnel URL, configures the backend's exact allowed origin and prints
the URL, run:

```bash
bash scripts/start-generic-v2.sh
```

The script never seeds or resets the database. Existing records remain intact.
On a brand-new database, initialize demo accounts separately using the optional
seed instructions below. Run the helper again if the tunnel restarts with a new
URL. The helper does not modify `.env`; it passes the URL directly to Compose.
Avoid subsequently recreating the backend with plain Compose commands unless
you also supply `GENERIC_V2_TUNNEL_ORIGIN`, as that restores the localhost-only
origin configuration. Use the helper for subsequent starts instead.

### Manual Compose alternative

Run from the repository root:

```bash
docker volume create gbscrm_generic_v2_database
docker volume create gbscrm_generic_v2_uploads
docker compose -f docker-compose.generic-v2.yml up --build -d
docker compose -f docker-compose.generic-v2.yml ps -a
```

The one-shot `db-init` service synchronizes the Prisma schema before starting
the backend. It never seeds or resets the database. If Prisma warns that schema
changes require data loss, startup fails rather than accepting that loss.
Inspect failures with:

```bash
docker compose -f docker-compose.generic-v2.yml logs db-init backend
```

### Optional demo account initialization — empty database only

**The seed script deletes existing database data. Run this only once on a new,
disposable Generic 2.0 database, never when preserving existing records.** Stop
the application services first so they do not access partially seeded tables:

```bash
docker compose -f docker-compose.generic-v2.yml stop frontend backend
docker compose -f docker-compose.generic-v2.yml run --rm --no-deps backend node prisma/seed.js
docker compose -f docker-compose.generic-v2.yml up -d
```

The seed creates `admin@globussoft.com` / `password123`, plus other demo accounts
and sample data. Recreating containers does not require rerunning it.

## Local addresses

- Frontend: <http://localhost:5174>
- Backend health: <http://localhost:3001/api/health>
- MySQL: `127.0.0.1:3308`, database `gbscrm_generic_v2`

All published ports bind to loopback. Credentials in this file are deliberately
local-only: do not use this stack unchanged for public/production hosting.
The frontend proxies API calls internally to `backend:3000`.

## Rebuild or recreate without losing records

```bash
docker compose -f docker-compose.generic-v2.yml up --build -d
# Or explicitly recreate all application containers:
docker compose -f docker-compose.generic-v2.yml up -d --force-recreate
```

This frontend serves a built snapshot. Rebuild after changing frontend code.

## Stop and restart

Stop containers and the tunnel, keeping all database records and uploads:

```bash
bash scripts/stop-generic-v2.sh
```

Stop and permanently delete **only** the Generic 2.0 database and upload volumes:

```bash
bash scripts/reset-generic-v2.sh
```

The reset script requires typing `DELETE GENERIC V2 DATA` before it changes
anything. It does not prune unrelated Docker resources or force-remove volumes
still in use. Deleted data requires a separate backup to recover. The next start
creates empty volumes; demo accounts require explicit initialization again.

Restart with `bash scripts/start-generic-v2.sh` to configure the tunnel URL
automatically. For local-only manual startup instead:

```bash
docker compose -f docker-compose.generic-v2.yml down
docker compose -f docker-compose.generic-v2.yml up -d
```

The fixed external volumes preserve MySQL data and `/app/uploads`, independent
of container IDs or checkout directory. Even Compose's `down --volumes` does
not remove external volumes. Keep using these exact volume names.

Persistence is on this Docker host only, not across machines. Explicit volume
deletion, Docker Desktop factory reset, disk loss or destructive seeding can
still erase data. Take database backups separately; a volume is not a backup.
Unconfigured third-party services (email, payment gateways, AI, object storage)
do not become available just because this local stack is running.

## Public testing URL (Cloudflare Quick Tunnel)

The `cloudflared` service starts automatically once the frontend is healthy.
Cloudflare generates a temporary `https://…trycloudflare.com` URL and prints it
in the container logs. No Cloudflare account or tunnel token is required.

Start and display the URL:

```bash
docker compose -f docker-compose.generic-v2.yml up --build -d
docker compose -f docker-compose.generic-v2.yml logs -f cloudflared
```

Press Ctrl+C to stop following logs; the detached containers keep running.
With `up` instead of `up -d`, the tunnel URL appears directly in attached output.
A fresh tunnel process may get a different URL; repeated `up -d` does not restart
an unchanged running tunnel. Read the latest startup logs rather than sharing an
older URL. The hostname is not a permanent deployment address.

### Allow the exact URL for API writes

The backend's origin checks reject unknown public origins. After obtaining the
URL, use it here (replace the example with the actual generated hostname):

```bash
export GENERIC_V2_TUNNEL_ORIGIN=https://your-actual-hostname.trycloudflare.com
docker compose -f docker-compose.generic-v2.yml up -d --no-deps backend
```

This recreates only the backend with the exact frontend origin allowed, keeping
the running tunnel/URL and database volumes intact. Keep the variable exported
for later Compose commands in this terminal, or put the same variable in the
gitignored root `.env` for persistence across terminals. Update it whenever the
tunnel URL changes. Localhost remains allowed. No wildcard allowlist or security
middleware bypass is introduced.

The public URL exposes the frontend **and its proxied API routes**. Anyone with
the URL can reach the application. Use disposable test data only, change known
demo passwords before sharing, and stop the tunnel when testing is finished:

```bash
docker compose -f docker-compose.generic-v2.yml stop cloudflared
```

Quick Tunnels are for testing, not production. For a stable URL and controlled
tester access, use a named tunnel with Cloudflare Access instead.

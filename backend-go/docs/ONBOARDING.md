# Onboarding: Working on the Go Backend

This guide gets new contributors productive in the `backend-go/` directory during the strangler-fig migration from Node.js.

## Prerequisites

- Go 1.24+
- Node.js 24 + npm (for the existing backend tests and Prisma)
- MySQL 8 (local or Docker)
- `make` (optional but recommended)

## Project layout

```
backend-go/
  cmd/api/          # HTTP server entry point
  config/           # env-driven configuration
  internal/
    app/            # Echo server setup + route registry
    handlers/       # HTTP handlers (thin)
    services/       # business logic + orchestration
    repository/     # DB access interfaces (database/sql for Phase 0)
    middleware/     # auth, RBAC, CORS, tenant, scrub, security headers
    shared/         # context, errors, audit hash helpers, sanitization
    domain/         # domain models by module
  test/contract/    # contract snapshot harness
  docs/             # runbooks and conventions
```

## Environment variables

Copy `backend/.env.example` to `backend/.env` and set the minimum required variables:

```bash
DATABASE_URL="mysql://root:local_dev_pw@localhost:3306/gbscrm_local?parseTime=true"
JWT_SECRET="dev-jwt-secret-change-me-in-production"
PORTAL_JWT_SECRET="dev-portal-secret-change-me-in-production"
NODE_ENV="development"
PORT="5000"
FRONTEND_URL="http://localhost:5173"
CORS_ALLOWED_ORIGINS="http://localhost:5173"
LOG_LEVEL="info"
```

The Go backend reads `DATABASE_URL`, `JWT_SECRET`, and `PORTAL_JWT_SECRET` from the environment. It refuses to boot in production if `JWT_SECRET` is missing.

## Run locally

```bash
cd backend-go
make build       # builds bin/api
make run         # runs cmd/api
make test        # runs go test ./...
make lint        # runs golangci-lint (install first)
make tidy        # runs go mod tidy
```

## Run with Docker Compose (full stack)

```bash
docker compose up --build -d
```

This starts:
- MySQL on `localhost:3307`
- Node.js backend on `localhost:3000`
- Go backend on `localhost:5000`
- Gateway on `localhost:8080` (routes `/api/health` and `/api/audit` to Go, rest to Node.js)
- Frontend on `localhost:5173`

## Test the migrated endpoints

```bash
# Health (unauthenticated)
curl http://localhost:5000/api/health

# Health (authenticated)
curl -H "Authorization: Bearer <staff-jwt>" http://localhost:5000/api/health

# Audit (ADMIN only)
curl -H "Authorization: Bearer <admin-jwt>" "http://localhost:5000/api/audit?limit=10"
```

## Working on a new module

See `backend-go/docs/RUNBOOK.md` for the step-by-step guide to adding a migrated module.

## Common gotchas

- **JWT payload key is `userId`, never `id`.** Use `req.user.userId` equivalents in Go.
- **Tenant isolation:** every list query must scope on `tenantId`. Add a test for any repository that touches tenant-scoped data.
- **Dangerous fields:** `id`, `userId`, `tenantId`, `createdAt`, `updatedAt`, `isAdmin`, `passwordHash`, `portalPasswordHash` are stripped from request bodies by `StripDangerous` and scrubbed from responses by `ScrubResponseMiddleware`.
- **Canonical error envelope:** all failures return `{ error, code }`. Use helpers in `internal/shared/errors.go`.
- **Route ordering:** literal paths must be mounted before parametric `:id` paths.

## Prisma Client Go (Phase 1)

Phase 0 uses `database/sql` with repository interfaces. The Prisma Client Go generator is configured in `backend/prisma/schema.prisma` and can be run with:

```bash
cd backend && npx prisma generate --generator goclient
```

Once generated, repository implementations can be switched to the generated client without changing handlers or services.

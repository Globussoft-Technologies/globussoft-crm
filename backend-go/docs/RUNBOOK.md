# Runbook: Adding a Migrated Module to the Go Backend

This runbook is for engineers adding a new route module to the Go backend during the strangler-fig migration.

## 1. Decide the module scope

- Identify the Express route module under `backend/routes/<module>.js`.
- Note its URL prefix (e.g., `/api/audit`, `/api/contacts`).
- Identify dependencies: other route modules, services, cron engines, external providers.
- Do not migrate dependencies in the same PR; migrate prerequisites first.

## 2. Update the routing registry

Edit `backend-go/config/routes.yaml` and add the module prefix under `migrated_prefixes`:

```yaml
migrated_prefixes:
  - exact: /api/health
  - prefix: /api/audit
  - prefix: /api/your-module   # <-- add
```

The gateway (Nginx or the Go reverse proxy) will route matching requests to the Go backend.

## 3. Add the domain package

Create `backend-go/internal/domain/<module>/` to hold business models specific to the module. Keep models small and focused on the API contract.

Example: `backend-go/internal/domain/audit/models.go`

## 4. Define the repository interface

Create `backend-go/internal/repository/<module>_repository.go`:

```go
type ContactRepository interface {
    List(ctx context.Context, tenantID int, p ListParams) ([]Contact, error)
    GetByID(ctx context.Context, tenantID, id int) (*Contact, error)
    Create(ctx context.Context, tenantID int, c *Contact) error
}
```

Phase 0 uses a `database/sql` implementation. Later phases will add Prisma Client Go implementations behind the same interface.

## 5. Implement the service

Create `backend-go/internal/services/<module>_service.go`:

```go
type ContactService interface { ... }

type contactSvc struct { repo repository.ContactRepository }
```

Services contain business logic, tenant scoping, and orchestration. They must not depend on HTTP or external providers directly.

## 6. Implement the handler

Create `backend-go/internal/handlers/<module>_handler.go`:

```go
type ContactHandler struct { svc services.ContactService }

func (h *ContactHandler) List(c echo.Context) error { ... }
```

Handlers are thin: parse input, call service, format response, handle errors using `shared.ErrResponse` or `shared.ErrInternal`.

## 7. Register routes in `internal/app/server.go`

Add the handler to `registerRoutes()` and mount the routes with the appropriate middleware:

```go
contactRepo := repository.NewContactRepository(db)
contactSvc := services.NewContactService(contactRepo)
ch := handlers.NewContactHandler(contactSvc)

g := s.e.Group("/api/contacts", middleware.RequireRole("ADMIN", "MANAGER", "OWNER"))
g.GET("", ch.List)
g.GET("/:id", ch.Get)
g.POST("", ch.Create)
```

Remember: literal paths (e.g., `/api/contacts/customer-ledger`) must be mounted **before** parametric paths (`/:id`).

## 8. Add tests

- Unit tests for the service: mock the repository and test business rules.
- Unit tests for the handler: use Echo's test recorder.
- Contract tests in `backend-go/test/contract/`: capture Node.js responses and compare with Go responses.
- Add E2E spec mapping in `backend-go/test/contract/e2e-mapping.yaml`.

## 9. Add/update CI jobs

If the module adds a new external dependency or a new top-level package, ensure `.github/workflows/go.yml` still covers it. Most additions do not need workflow changes.

## 10. Verify before merging

Run locally:

```bash
cd backend-go
go test ./...
go build -o bin/api ./cmd/api
NODE_ENV=development PORT=5100 DATABASE_URL="..." JWT_SECRET="..." go run ./cmd/api
```

Hit the endpoints:

```bash
curl http://localhost:5100/api/health
curl -H "Authorization: Bearer <token>" http://localhost:5100/api/your-module
```

## 11. Gateway cutover

After merging:

1. Update Nginx or the gateway registry to route the migrated prefix to the Go backend.
2. Run the full E2E suite for the module against the hybrid stack.
3. Monitor for 30 minutes after cutover; be ready to revert the registry entry to Node.js.

## 12. Post-cutover checklist

- [ ] E2E specs for the module pass against Go.
- [ ] Snapshot harness shows zero unexpected diffs.
- [ ] Load test P95 is equal or better than Node.js.
- [ ] Security reviewer confirms RBAC, tenant isolation, and audit logging are preserved.
- [ ] Runbook updated if the pattern changed.

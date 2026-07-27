# Go Backend Code Style and Conventions

This document complements `AGENTS.md` and the project-wide conventions with Go-specific rules.

## General

- Follow idiomatic Go: effective Go, standard formatting, and `gofmt`.
- Keep packages small and focused. A package should have a single responsibility.
- Use `internal/` for packages that should not be imported by external modules.
- Prefer explicit error handling over panics. Panics are reserved for programmer errors only.
- Every exported symbol must have a doc comment.

## Naming

- `PascalCase` for exported identifiers; `camelCase` for unexported.
- Interfaces are usually named with the capability they represent, e.g., `AuditService`, `AuditRepository`.
- Acronyms are all-caps: `HTTP`, `URL`, `JWT`, `RBAC`, `API`.

## Imports

- Group imports: standard library, third-party, project internal.
- Use `goimports` or `gofmt` to keep imports clean.
- Project imports use the module path: `github.com/Globussoft-Technologies/globussoft-crm/backend-go/internal/...`.

## Error handling

- Wrap errors with context when crossing package boundaries: `fmt.Errorf("...: %w", err)`.
- Use canonical error envelopes for HTTP responses via `shared.ErrResponse`, `shared.ErrInternal`, `shared.ErrUnauthorized`, `shared.ErrForbidden`.
- Error `code` values are stable strings; do not change them without updating the frontend and E2E specs.

## Middleware

- Order is load-bearing. The current order in `internal/app/server.go` is:
  1. Request ID
  2. Logger
  3. Recover
  4. CORS
  5. Security headers
  6. Body limit
  7. Gzip
  8. Strip trailing slash
  9. Origin check
  10. Tenant resolution
  11. Auth (JWT)
  12. Strip dangerous
  13. Sanitize body
  14. Scrub response
- Add new global middleware only after reviewing the Node.js middleware order.

## Handlers

- Handlers are thin. They should:
  - Parse and validate input.
  - Call a service.
  - Return the correct HTTP status and JSON envelope.
  - Not contain business logic or direct DB calls.
- Use Echo's context binding and validation helpers.
- Always set `Content-Type` to JSON for API responses.

## Services

- Define interfaces for services. This enables mocking in tests.
- Business logic lives here: orchestration, transformations, external provider calls.
- Services should be tenant-unaware where possible; tenant scoping belongs in the repository layer.

## Repositories

- Define interfaces for repositories. Phase 0 uses `database/sql`; Phase 1 will add Prisma Client Go implementations.
- Every list query must include `tenantId` scoping. Add tests that fail if it is missing.
- Use parameterized queries. Never build SQL with `fmt.Sprintf` for user input.
- Close `rows` and connections promptly.

## Testing

- Use `testify/assert` for assertions.
- Mock interfaces with hand-written fakes or `gomock`/`mockery` once introduced.
- Handler tests use `httptest` and Echo's test recorder.
- Add a contract snapshot for every migrated endpoint.

## Security

- JWT payload key is `userId`, never `id`.
- Tenant isolation is mandatory at the repository layer.
- Never return `passwordHash`, `portalPasswordHash`, or `isAdmin` in responses.
- Strip dangerous fields from request bodies before binding.
- Use rate limiting for auth and public endpoints.

## Logging

- Use the server logger (`logrus`). Avoid `fmt.Println` in production code.
- Include request IDs in logs for traceability.
- Do not log secrets, JWTs, or PII.

## Migrations

- Do not hand-write Prisma models. Continue using `backend/prisma/schema.prisma` as the source of truth.
- Add new Prisma migrations via the Node.js backend workflow; the Go backend reads the same MySQL schema.
- Phase 1 will switch repository implementations to Prisma Client Go generated models.

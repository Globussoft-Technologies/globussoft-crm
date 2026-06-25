# Security

This documents what the scaffold enforces today and what must be added before
production. Being explicit matters: an LLM-orchestration system has two unusual
risk areas — **runaway spend** (each request fans out into many paid model
calls) and **prompt injection** (tool outputs flow back into the model).

## Enforced now (in code)

| Control | Where | What it does |
|---|---|---|
| **Per-run cost budget** | `packages/core` agent loop (`MAX_RUN_BUDGET_USD`) | Tracks total billed USD across the CEO + all specialists and aborts the run if it exceeds the cap. Primary runaway-spend protection. |
| **Step + delegation caps** | `packages/core` (`MAX_AGENT_STEPS`, `MAX_DELEGATION_DEPTH`) | Bounds total model calls and recursion depth per run. |
| **Rate limiting** | `apps/web` API routes (`RATE_LIMIT_PER_MINUTE`) | Per-client fixed-window limit on `/api/runs` (+ generous limits on GETs). In-memory — see "Deferred" for multi-instance. |
| **Concurrency cap** | `apps/web` (`MAX_CONCURRENT_RUNS`) | Caps simultaneous orchestrations; excess requests get 429. |
| **Input validation** | `POST /api/runs` | Requires a non-empty goal, enforces `MAX_GOAL_CHARS`, and allowlists `sectorKey` against registered packs. |
| **SSRF protection** | `packages/tools` `web_fetch` | http(s) only, resolves the host and blocks loopback/private/link-local/CGNAT/multicast and the `169.254.169.254` metadata IP; redirects disabled. |
| **Tool approval gating** | `packages/core` (`ORCHESTRATION_MODE`) | `ask` tools route through the approval policy; `supervised` mode is the hook for human gating. |
| **Security headers** | `apps/web/next.config.mjs` | `X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN` + CSP `frame-ancestors 'self'` (so the dashboard can preview its own `/generated` PDFs; other origins still cannot frame it), `Referrer-Policy`, `Permissions-Policy`, COOP, and a baseline CSP with `img-src 'self' data: https:`. Generated HTML deliverables are script-stripped (`sanitizeHtml`) and rendered in a sandboxed preview iframe, so the same-origin framing relaxation does not enable self-XSS. |
| **Secret hygiene** | throughout | Keys are read only from env, never logged, never written into prompts/messages. `.env` is gitignored. |
| **Safe error responses** | `apps/web` API | Client-facing errors are generic; internals aren't leaked. |

## Deferred — required before production

These need the auth/infra layer that the scaffold intentionally omits:

- **Authentication & authorization** — no user/tenant identity yet. Add
  Clerk/Auth0/WorkOS; attach `tenantId` to every request and run.
- **Tenant isolation** — enforce Postgres **row-level security** keyed on
  `tenant_id` so one tenant can never read another's runs/usage.
- **Distributed rate limiting & concurrency** — the in-memory limiter/concurrency
  counter are per-instance. Move to Redis for multi-instance deployments.
- **Secret encryption at rest** — `provider_keys.encrypted_key` (BYOK) must be
  encrypted with KMS/Vault. Never store plaintext.
- **Tighten CSP** — the dev CSP allows `unsafe-inline`/`unsafe-eval` (Next dev
  needs them). Use a nonce-based strict CSP for production builds.
- **CSRF / origin checks** — once cookie-based auth exists, add CSRF protection
  and origin allowlisting on state-changing routes.
- **Egress allowlist for tools** — beyond SSRF blocking, consider an allowlist of
  permitted domains per tenant/sector.
- **Audit logging & alerting** — ship the event/usage log to durable storage;
  alert on budget-cap hits, repeated 429s, and approval denials.
- **Dependency & secret scanning** — `npm audit`, SCA, and secret-scanning in CI.

## Reporting

For a real deployment, add a security contact and disclosure process here.

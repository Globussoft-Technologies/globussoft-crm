---
name: writing-api-gate-spec
description: Authors a new Playwright API spec for routes in this CRM. Use when adding gate coverage for an under-tested route — the R-1/R-4/R-6 small-route picks, G-x cron-engine specs, or any item from the regression-coverage-backlog. Encodes the standing rules every spec needs (JWT key is userId not id, body strips id/createdAt/updatedAt/tenantId/userId, header JSDoc, RUN_TAG conventions linked to e2e/test-data-patterns.js, afterAll cleanup pattern with the _teardown_ prefix not _CLEANED_, no Co-Authored-By in commits) so a fresh agent doesn't re-derive them. After the spec is green, hand off to the wiring-spec-into-gate skill to add it to CI.
---

# Writing an API gate spec

## When to use

You're adding a new `e2e/tests/<area>-api.spec.js` that asserts route-level contracts (status codes, response shapes, tenant scoping, RBAC) against a running backend with a real DB. The spec will be wired into `deploy.yml`'s `api_tests` gate and run on every push.

NOT this skill: UI-flow specs (those need a SPA served — see how `wellness-real-user-journeys.spec.js` skips when local stack is API-only); cron-engine SPECS that are heavily side-effect-driven (those usually pair with a NEW admin trigger endpoint — that's the `adding-admin-trigger-endpoint` skill).

## Standing rules (apply to every spec)

These are non-negotiable. Every existing gate spec follows them; agents that re-derive them waste prompt tokens.

- **JWT key:** `req.user.userId` — NOT `.id`. ESLint blocks the wrong form. The 6b1470f sweep was the canonical lesson.
- **Body strips:** the global `stripDangerous` middleware deletes `id`, `createdAt`, `updatedAt`, `tenantId`, `userId` from EVERY request body. If your test needs to reference a user by id in a body, use `targetUserId` (or any non-stripped name).
- **Header JSDoc** (per `feedback_descriptive_headers.md` memory): every spec opens with a JSDoc block covering: what's tested + which module + WHY (the regression class) + EXACT endpoints with status-code + error-key contracts + non-obvious setup pitfalls + test environment expectations (BASE_URL, login creds, seed data the spec depends on). See `TEMPLATE.md` for the skeleton.
- **No `Co-Authored-By: Claude`** in commit messages (global rule).
- **Lowercase + hyphenated** spec filename: `<area>-api.spec.js`. The route file is usually under_score; the spec is hyphen-case.

## Pattern selection — clone an existing spec, don't write from scratch

| Route shape | Reference spec | Why |
|---|---|---|
| Plain CRUD (GET list / POST / PUT / DELETE / GET :id) | `e2e/tests/notifications-api.spec.js` | Canonical CRUD pattern. Cached-token + authXyz helpers. |
| State-machine + tenant-isolation describe-block | `e2e/tests/landing-pages-api.spec.js` (1e5bd3e — 41 tests) | Cleanest example of the 11-describe-block layout with state-machine drift documentation. |
| Cron-engine spec (admin-gated trigger + side-effect assertions) | `e2e/tests/sequence-engine-api.spec.js` (canonical) OR `e2e/tests/recurring-invoice-api.spec.js` (902e439, today's closest analog) OR `e2e/tests/wellness-ops-api.spec.js` (853f41e, for engine-window math + Survey-row dedup) | Three canonical engine-spec shapes; pick the closest. |
| Compliance/audit-relevant (PII, RBAC) | `e2e/tests/audit-api.spec.js` (f5e9c7c) | Tight RBAC matrix + tenant-scoping defence-in-depth. |
| External partner API (X-API-Key) | `e2e/tests/external-api.spec.js` | Per-tenant API-key bootstrap pattern. |

Read the chosen reference end-to-end before writing yours. Don't copy line-by-line; copy the SHAPE.

## RUN_TAG + cleanup conventions

Every spec uses a `RUN_TAG` prefix on fixture names so global-teardown sweeps residue. The set of patterns global-teardown matches lives at `e2e/test-data-patterns.js`. Pick a unique tag per spec:

```js
const RUN_TAG = `E2E_FLOW_<AREA>_${Date.now()}`;
// Examples:
//   E2E_FLOW_LP_<ts>      — landing pages (G-1)
//   E2E_FLOW_WF_<ts>      — workflows (G-2)
//   E2E_FLOW_AUDIT_<ts>   — audit (G-5)
//   E2E_FLOW_REMINDERS_<ts> — appointment reminders (G-6)
//   E2E_FLOW_RECINV_<ts>  — recurring invoice (G-9)
//   E2E_FLOW_RETENTION_<ts> — retention (G-11)
```

If your area's prefix doesn't already match one of the regexes in `e2e/test-data-patterns.js`, ADD it there in the same commit — otherwise teardown won't sweep your stragglers.

## afterAll cleanup — use `_teardown_` not `_CLEANED_`

The wellness-clinical-api lesson (commit `02a4d1e`): a previous agent renamed seeded Locations to `${RUN_TAG}_CLEANED_LOC_${id}` thinking that satisfied cleanup, but the renamed rows STILL started with `E2E_` so demo-hygiene's residue regex caught them mid-suite.

**Use these patterns instead:**

- **DELETE-able resources:** track ids in `createdXxxIds[]`, `afterAll` calls `authDelete` on each. Mirror G-6 appointment-reminders + G-8 low-stock specs.
- **No DELETE endpoint** (e.g. some Location/Patient routes): PUT-rename to `_teardown_<area>_${id}` (no `E2E_` substring → residue regex misses) AND set `isActive=false` so list/public endpoints filter the row out. See `appointment-reminders-api.spec.js:194` for the canonical PUT-rename.
- **Engine fan-out side effects** (Notifications, AuditLog rows the engine wrote): add a sweep for those too. See G-8's afterAll deleting Notification rows by RUN_TAG match.

## Acceptance criteria — the standard set

Every spec MUST cover these (work out exact contracts from the route file):

1. **Happy path** for each endpoint — minimum payload + valid auth → expected 200/201 + correct response shape
2. **400 validation** — bad input on each endpoint that has validators
3. **404 missing** — id-bearing endpoints with a non-existent id
4. **Auth gate** — no token → 401/403 (route-dependent — accept `[401, 403]` since the global guard returns 403 and verifyToken returns 401)
5. **Tenant isolation** — create a row as Tenant A, fetch as Tenant B, assert NOT visible. Critical class.
6. **RBAC** where applicable — if route uses `verifyRole(['ADMIN'])` or `verifyWellnessRole(...)`, assert MANAGER + USER → 403.
7. **Self-clean** — afterAll cleans up everything the spec created (per the cleanup section above).

For state-machine routes (publish/unpublish, approve/reject), document idempotency vs cross-state contracts in the spec header — the route may be idempotent-200 same-state + 422 cross-state (the canonical pattern; see `approvals-flow.spec.js`), or always-422 (rare). Match what the route actually does, not what the gap card says — gap cards drift.

## Verification flow before commit

1. **Boot local stack:** `.\scripts\local-stack-up.ps1` (Docker MySQL :3307 + backend :5000).
2. **Run the new spec in isolation:** `cd e2e && BASE_URL=http://127.0.0.1:5000 npx playwright test --project=chromium --no-deps tests/<your-new-spec>.spec.js` — must be all-green.
3. **Run an adjacent regression sanity check** so you know you haven't broken a sibling spec: pick a related spec (e.g. for billing-recurring-invoice run `tests/billing-api.spec.js`; for email-scheduled run `tests/email-api.spec.js`).
4. **Quick contract-drift sanity:** if the route was missing a guard the gap card said it had (or vice versa), don't fix it in this PR — file as a separate `[regression]` issue with the surfacing spec name. The G-3 + G-5 + G-9 + G-11 + G-12 specs all surfaced real bugs this way.
5. **Commit and push.** Then use the **`wiring-spec-into-gate`** skill to add it to deploy.yml + coverage.yml.

## Commit message format

```
test(api): <area>-api gate (<gap-id>) — <one-line summary>

routes/<area>.js was [zero / smoke-only] coverage. New spec asserts
[brief description of what's tested].

Pattern: e2e/tests/<reference-spec>.spec.js.
[If contract drift surfaced: also adds [regression] issue #XXX.]

Closes <gap-id> from docs/E2E_GAPS.md.
```

## Templates

See `TEMPLATE.md` in this skill for the spec skeleton with the JSDoc header pre-filled. Copy + replace the `<area>` / `<RUN_TAG>` / `<endpoint>` placeholders.

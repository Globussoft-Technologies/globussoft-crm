---
name: adding-admin-trigger-endpoint
description: Adds a new admin-gated POST endpoint that manually triggers a cron engine for the requesting tenant. Use when writing a cron-engine spec (G-9/G-10/G-11/G-12/G-14/G-15 pattern) and the engine has no manual-trigger surface — without one, the spec can only wait for the cron tick which is non-deterministic. Encodes the canonical mirror pattern (verifyToken + verifyRole(['ADMIN']) + per-tenant scope via req.user.tenantId + return envelope shape) plus the optional confirmDestructive body guard for destructive ops like GDPR retention. Pairs with writing-api-gate-spec for the test side.
---

# Adding an admin trigger endpoint

## When to use

You're writing a spec for a cron engine (`backend/cron/<engine>.js`) and there's no `POST /api/<area>/run` route to trigger it manually. Without a trigger, the spec has to wait for the next cron tick — non-deterministic and slow.

Add the trigger endpoint as part of the same commit as the spec, mirroring the canonical pattern. Six engines today got this treatment in v3.4.x: G-7 wellness-ops, G-8 low-stock, G-9 recurring-invoice, G-10 scheduled-email, G-11 retention (GDPR), G-12 campaign, G-14 forecast-snapshot, G-15 backup.

## The canonical pattern

Every trigger endpoint follows the same shape. It does NOT redo the engine's work — it CALLS the engine's per-tenant function with `req.user.tenantId`. Cron and manual paths share the same business logic, so they can never drift on dedup semantics.

```js
// backend/routes/<area>.js (existing route file — append the new handler)

const { verifyToken, verifyRole } = require('../middleware/auth');
const { runForTenant } = require('../cron/<engine>'); // or whatever the engine exports

// POST /api/<area>/run — admin-gated manual trigger for cron/<engine>.js
//
// Mirror of /api/forecasting/snapshot/run + /api/billing/recurring/run +
// /api/email/scheduled/run (admin-gated, per-tenant scope, predictable
// envelope). Calls the engine's per-tenant function with the requesting
// admin's tenantId so cron + manual paths can never drift on dedup
// semantics.
router.post('/run', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
  try {
    const result = await runForTenant({
      id: req.user.tenantId,
      // ... pass any tenant context the engine needs from req.user
    });
    res.json({
      success: true,
      tenantId: req.user.tenantId,
      ...result, // engine returns { processed, sent, skipped, errors }
    });
  } catch (err) {
    console.error('[<area>] manual trigger failed:', err);
    res.status(500).json({
      success: false,
      tenantId: req.user.tenantId,
      error: err.message,
      code: '<AREA>_RUN_FAILED',
    });
  }
});
```

## Naming convention

| Engine | Route mount | Endpoint path |
|---|---|---|
| `wellnessOpsEngine.js` | `/api/wellness` | `POST /api/wellness/ops/run` |
| `lowStockEngine.js` | `/api/wellness` | `POST /api/wellness/inventory/low-stock/run` |
| `recurringInvoiceEngine.js` | `/api/billing` | `POST /api/billing/recurring/run` |
| `scheduledEmailEngine.js` | `/api/email` | `POST /api/email/scheduled/run` |
| `retentionEngine.js` | `/api/gdpr` | `POST /api/gdpr/retention/run` |
| `forecastSnapshotEngine.js` | `/api/forecasting` | `POST /api/forecasting/snapshot/run` |
| `campaignEngine.js` | `/api/marketing` | `POST /api/marketing/campaigns/run` |
| `backupEngine.js` | `/api/admin` | `POST /api/admin/backup/run` |

Pattern: mount the trigger UNDER the existing area router, with a path that names the engine's role. Use kebab-case for multi-word names.

## Return envelope

ALWAYS return this shape on success:

```js
{
  success: true,
  tenantId: <number>,    // echoed for the spec to assert isolation
  ...counters,           // engine-specific: processed, sent, skipped, generated, deleted, etc.
  errors: [<string>...], // empty array on full success; populated when per-row errors occurred but engine continued
}
```

On failure (engine threw at the top level — usually means infrastructure failure, not per-row):

```js
{
  success: false,
  tenantId: <number>,
  error: <string>,
  code: '<AREA>_RUN_FAILED',
}
```

The spec asserts both shapes. Don't deviate without good reason.

## RBAC contract

`verifyToken, verifyRole(['ADMIN'])` is the default. Two carve-outs to consider:

- **Wellness routes** — use `verifyWellnessRole(['admin', 'manager'])` instead, since wellness has its own role hierarchy (admin / manager / doctor / professional / telecaller / helper). See `routes/wellness.js` for the helper.
- **GDPR / destructive operations** — add a SECOND guard: a body field `confirmDestructive: true`. Without it, return 400 `CONFIRMATION_REQUIRED`. Pattern from G-11 (retention engine, commit `cb96793`):

```js
router.post('/retention/run', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
  if (req.body?.confirmDestructive !== true) {
    return res.status(400).json({
      success: false,
      error: 'Set body.confirmDestructive=true to actually delete',
      code: 'CONFIRMATION_REQUIRED',
    });
  }
  // ... proceed
});
```

## AuditLog row writes (for destructive ops)

Destructive engines (retention, mass-delete, GDPR sweeps) MUST write an AuditLog row per deletion. The cron path may not (G-11 surfaced this — `retentionEngine.js` skipped audit on `deleted=0` runs, fixed in #411). Match the engine's policy here; if the engine writes audit rows the manual endpoint should too.

```js
await prisma.auditLog.create({
  data: {
    entity: '<EntityType>',
    action: 'DELETE',           // match existing audit-vocabulary
    entityId: deleted.id,
    userId: req.user.userId,    // NOT req.user.id (the JWT key is userId)
    tenantId: req.user.tenantId,
    details: { via: 'manual', /* engine-specific context */ },
  },
});
```

The `via: 'manual'` (or `'cron'`) field in `details` is how the spec distinguishes which path wrote the row.

## Wiring the route

Add the new route handler to the existing route file (e.g. `backend/routes/billing.js` for recurring-invoice). Don't create a new file unless the area doesn't have one. The route is auto-mounted via `server.js` if the area router already exists.

If you're adding the FIRST endpoint for a new area (rare — happened only with `routes/admin.js` for G-15 backup), you also need to:
1. Create `backend/routes/<area>.js`
2. Add `app.use('/api/<area>', require('./routes/<area>'))` to `server.js` near the other route mounts
3. Add `/<area>` to the openPaths whitelist in `server.js` if any sub-route is public (rare for trigger endpoints; admin-gated by definition)

## Verification

1. **Boot local stack** if not running: `.\scripts\local-stack-up.ps1`.
2. **Quick curl smoke test:**
   ```bash
   TOKEN=$(curl -s -X POST http://127.0.0.1:5000/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"admin@globussoft.com","password":"password123"}' \
     | python -c "import json,sys;print(json.load(sys.stdin)['token'])")
   curl -X POST http://127.0.0.1:5000/api/<area>/run \
     -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{}'
   ```
   Expected: 200 with `{ success: true, tenantId: 1, ...counters }`.
3. **Confirm 403 for non-admin:**
   ```bash
   MGR=$(curl -s -X POST http://127.0.0.1:5000/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"manager@crm.com","password":"password123"}' \
     | python -c "import json,sys;print(json.load(sys.stdin)['token'])")
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:5000/api/<area>/run \
     -H "Authorization: Bearer $MGR"
   # Expect: 403
   ```
4. **Then write the spec** using `writing-api-gate-spec` skill — the route is the test target.

## Commit message format

```
feat(<area>) + test(api): <engine-name>-engine gate (<gap-id>)

Adds POST /api/<area>/<route> admin-gated trigger endpoint mirroring
/api/forecasting/snapshot/run + /api/billing/recurring/run pattern.
Wraps cron/<engine>.js's per-tenant logic for the requesting tenantId.

[If confirmDestructive guard added: also adds body.confirmDestructive
guard with 400 CONFIRMATION_REQUIRED, mirroring G-11.]

Spec asserts <list of acceptance assertions>. Wire-in to deploy.yml
+ coverage.yml.

Closes <gap-id> from docs/E2E_GAPS.md.
```

## Pitfalls

- **Don't duplicate engine logic in the route** — call `runForTenant(...)` from the engine module. If the engine doesn't expose a per-tenant function (rare; campaignEngine started this way), the trigger-adder has the side benefit of forcing a refactor that makes the engine testable.
- **`req.user.tenantId` not `req.body.tenantId`** — the latter is stripped by `stripDangerous` middleware AND would let any admin trigger another tenant's engine. Always derive from the JWT.
- **`req.user.userId` not `req.user.id`** — ESLint blocks the latter, but worth saying again.
- **Don't echo input back as part of the envelope** — return the engine's output, not what the caller sent. Matches the manual-trigger contract.

## Templates

See `TEMPLATE.js` for the route-handler skeleton.

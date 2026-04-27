# Cron / Long-Running-Job Sandbox Harness — Plan

> **Status:** plan only. No code is shipped here. This file documents the
> pattern a future session should implement to close the cron-coverage gap
> identified in issue #137.

## Goal

Let an E2E test exercise any of the 19 cron engines under `backend/cron/`
deterministically — without waiting wall-clock time, without flapping, and
without needing the engine's real schedule to have ticked.

## The pattern

```
┌──────────────────────┐    DISABLE_CRONS=1    ┌───────────────────────────┐
│  CRM under test      │◄─────────────────────►│  Playwright spec          │
│  (no cron ticks)     │                       │  (helpers/cron.js)        │
└──────────┬───────────┘                       └────────────┬──────────────┘
           │                                                │
           │  POST /api/admin/cron/:engine/run              │
           │  (superuser JWT)                               │
           │◄───────────────────────────────────────────────┘
           │
           │  invokes engine.run()  (synchronous, awaits completion)
           │
           │──► DB side effects land  (Contact, Activity, Notification, …)
           │
           │  GET /api/contacts/:id, etc.                    │
           │───────────────────────────────────────────────►│
           │                          assert side effects   │
```

### Steps for a new engine spec

1. **Boot CRM with `DISABLE_CRONS=1`** (already standard in CI per
   `backend/server.js`).
2. **Seed fixture data** specific to the engine (e.g. for
   `recurringInvoiceEngine`: a deal + active recurring template that's due
   today). Tag with `tenantId="sandbox"` or `meta.sandbox=true` for cleanup.
3. **POST** `/api/admin/cron/:engine/run` with the superuser token.
4. **Wait for the response** — the admin endpoint awaits engine completion
   before returning so tests don't need polling.
5. **Assert** — read back via existing CRM API endpoints or via a thin
   `/api/admin/db/dump?model=…` (also yet-to-build).
6. **Clean up** — delete by tag.

## What needs to be built

### 1. Admin run endpoint (backend)

`POST /api/admin/cron/:engine/run` — RBAC: ADMIN only. Looks up the engine
by name in a registry (`cron/index.js` or similar), invokes its exported
`run()` function, awaits, returns `{ ok, durationMs, result }`.

Some engines (orchestrator, sequence) already export a `run()` that's
separate from the cron handle. Others (backup, retention) do not — they
need to be split: the cron `schedule()` call should be a thin wrapper around
a plain async `run()` function.

### 2. Test helper

`e2e/tests/helpers/cron.js` — single function:

```js
async function triggerCron(request, engine, { token }) {
  const res = await request.post(`/api/admin/cron/${engine}/run`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}
```

### 3. Coverage specs

One spec per **uncovered** engine (eight new specs):

| File | Engine | Fixture |
|---|---|---|
| `e2e/tests/cron-campaign.spec.js` | `campaignEngine.js` | active Campaign + recipients |
| `e2e/tests/cron-recurring-invoice.spec.js` | `recurringInvoiceEngine.js` | recurring template due today |
| `e2e/tests/cron-scheduled-email.spec.js` | `scheduledEmailEngine.js` | ScheduledEmail in past |
| `e2e/tests/cron-retention.spec.js` | `retentionEngine.js` | old data + retention policy |
| `e2e/tests/cron-backup.spec.js` | `backupEngine.js` | assert backup file appears |
| `e2e/tests/cron-appointment-reminders.spec.js` | `appointmentRemindersEngine.js` | wellness visit due in 24h |
| `e2e/tests/cron-wellness-ops.spec.js` | `wellnessOpsEngine.js` | visit completed 72h ago |
| `e2e/tests/cron-low-stock.spec.js` | `lowStockEngine.js` | service with low stock |

### 4. Mock-server orchestration

For specs whose engine emits outbound calls (campaign → Mailgun/Twilio,
appointment-reminders → WhatsApp, etc.), the corresponding sandbox mock from
`backend/scripts/sandbox/` must be running. That's an
`e2e/playwright.config.js` `globalSetup` change — out of scope here.

## Engines with PARTIAL coverage

Per `docs/wellness-client/SANDBOX.md` §2a, several engines have specs that
test the UI/config side but not the engine tick. Those specs should be
**augmented** rather than replaced:

- `sequences-flow.spec.js` — already drives a sequence, but via direct DB
  manipulation, not engine.run(). Add an engine-tick assertion.
- `lead-sla.spec.js` — same: covers the breach UI, not the engine tick.
- `sentiment.spec.js`, `deal_insights.spec.js`, `forecasting.spec.js` —
  same.

## Out of scope here

- Implementing the admin endpoint.
- Refactoring engines that don't expose `run()`.
- Writing the eight new specs.
- Wiring mock servers into `globalSetup`.
- CI job for sandbox-tagged specs.

All of the above is the multi-day follow-up referenced in
[`docs/wellness-client/SANDBOX.md`](../docs/wellness-client/SANDBOX.md) §4.

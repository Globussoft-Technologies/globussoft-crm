> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-03 late night — second 4-agent parallel wave + audit follow-through) — superseded above

**HEAD on origin/main:** `81ec5ad`. Per-push gate ✅ GREEN. Live on demo.

### Why this session

User asked "did you fix the bugs Mr. Agents found?" — surfaced an honest audit gap. The first 4-agent wave fixed assigned tasks but found **4 additional bugs** that were filed but not patched:
- #417 Backup engine pipeline-exit-code masking (Agent 1's deeper finding)
- #418 routes/workflows.js missing GET /:id
- #419 routes/custom_objects.js entities lacking GET/PUT/DELETE by id
- #420 wellness treatments path inconsistency (POST and PUT at different paths)

Plus issues filed earlier this multi-session arc still pending: #412, #413, #414, #415, #416 (#412 + #416 closed during this session).

### What shipped this session (6 commits, all CI-green)

| Commit | What | Closes |
|---|---|---|
| `03071ff` | **fix(#417)**: backup engine — replace shell pipeline with `spawn` pipe to observe both exit codes. **Real architectural fix**: drops `mysqldump | gzip` shell pipeline (POSIX `sh` no `pipefail` → gzip masks dump's exit code), uses two-child `spawn` with observable exit codes per stage. New `MYSQLDUMP_TIMEOUT` code via `SIGKILL` watchdog. Streams end-to-end (no maxBuffer OOM). New test scenario: `MYSQLDUMP_BIN=/bin/false` proves runtime-failure detection. `runBackup()` is now async (single in-tree caller in `routes/admin.js` updated to `await`). Bonus: argument-quoting hardening (no more shell-string interpolation). | #417 |
| `2eb7dbc` | **fix(#418)**: add `GET /:id` to `routes/workflows.js`. One handler, 19 lines. Tenant-scoped `findFirst({ id, tenantId })`. Fills the API surface gap that forced the G-20 spec to use list-fallback. | #418 |
| `b90ac7c` | **fix(#419)**: add `GET / PUT / DELETE /entities/:id` to `routes/custom_objects.js`. **Refuse-when-records-exist DELETE policy** (409 `ENTITY_HAS_RECORDS` rather than silent cascade). Shared `validateEntityPayload` between POST and PUT. Audit row written before destructive ops. Bonus: pre-#419 POST crashed on `fields=undefined` (`fields.map`); now treats as `[]`. | #419 |
| `cea9bc0` | **fix(#420)**: consolidate wellness treatments → treatment-plans (single canonical path). New `POST/GET /treatment-plans` + `GET /treatment-plans/:id` (PUT already existed). Legacy `POST /wellness/treatments` returns 410 Gone with `code: WELLNESS_TREATMENTS_RENAMED` + `canonical: '/api/wellness/treatment-plans'`. Frontend `PatientDetail.jsx` PlansTab migrated. Existing `treatment-plans-api.spec.js` extended with 4 new tests + 4 deprecation-path tests. `docs/API_NAMESPACING.md` updated. | #420 |
| `1f5f35a` | fix-up: widen `ALLOWED_FIELD_TYPES` whitelist to accept the 'String' vocabulary that existing custom-objects-api.spec.js fixtures + seeded tenant data use (`String, Text, Number, Integer, Float, Boolean, Date, DateTime, JSON`). Agent #419's narrow whitelist was rejecting valid existing data. | (residual) |
| `81ec5ad` | test fix-up: `custom-objects-api.spec.js` "missing fields → 500" test was documenting a pre-#419 bug Agent #419 incidentally fixed. Updated assertion `[400, 500]` → `[201, 400]` to match the new correct behavior. | (residual) |

### Issues closed this session
- ✅ #417 backup-engine pipeline-exit-code masking (commit `03071ff`)
- ✅ #418 workflows GET /:id (commit `2eb7dbc`)
- ✅ #419 custom-objects entities CRUD by id (commits `b90ac7c` + `1f5f35a`)
- ✅ #420 wellness treatments path consolidation (commit `cea9bc0`)

### Per-push gate state (post this session)

~52 specs / **~1,735+ tests** + 31 vitest files / **~809 unit tests** = **~2,544+ tests on every push**, all green. Live on demo at `81ec5ad`.

### Three things to do first next session

1. **Tag v3.4.4** — eight closed issues this multi-session arc (#408 #409 #410 #411 + #412 #416 #417 #418 #419 #420) plus G-20 wave 1+2 plus T2.1 mobile + T1.2 SMS. That's a meaningful release. `git tag -a v3.4.4 ...` + push to fire e2e-full release-validation against demo.

2. **G-20 wave 3** (~half day). With #418 and #419 closed, two new resources can land cleanly: `workflows` (now has GET /:id; the G-20 list-fallback can be cleaned up), and `custom-objects/entities` (new full CRUD surface). Plus the still-pending wave 3 set: `wellness/treatment-plans` (now consolidated, can use the FK chain pattern), Activities, RecurringInvoices, AuditLog, CustomRecords, Currencies, Scim, Tenants.

3. **Verify T2.1 mobile drawer** on the live demo at 375×812 viewport (Chrome DevTools mobile emulator or a real iPhone). The build passed but the actual drawer animation + focus trap haven't been visually confirmed against demo.

### Long tail still open

- #413 — 49 models without `tenant Tenant @relation` (cascade leak on `Tenant.delete()`)
- #414 — `MarketplaceLead.@@unique([provider, externalLeadId])` excludes tenantId
- #415 — 21 `@@unique` constraints lack documenting comments
- T2.2 — Audit-log middleware build-out (4-5 days; Patient/Visit/Rx/Consent mutations)
- T2.3 — Ship P1 of regression backlog
- G-21 — Frontend vitest+RTL setup (3-5 days; 80 pages + 11 components have zero isolated tests)
- G-22 — Integration test tier (msw/nock) — Stripe webhook signing
- G-23 — Migration safety check (prisma migrate dry-run in CI)

---


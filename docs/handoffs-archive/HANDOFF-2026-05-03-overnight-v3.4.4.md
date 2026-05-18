> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-03 overnight — autonomous-orchestrator session, v3.4.4 release candidate) — superseded above

**HEAD on origin/main:** `f4b4ebe`. Per-push gate ✅ GREEN. Live on demo. 43 commits since v3.4.3 (`461a228`).

### Why this session

User said *"Now you try to be an autonomous orchestrator and, using your skills, try to close all the gaps in the documents"* + *"agents should write to the front end so I should know what's going."* This session executed both: G-20 tenant-isolation flagship across 3 parallel waves, plus building the agent-activity infra so the user can watch waves in real time at `/developer`.

### What shipped this session

**Phase 1 — Skills authoring** (so subsequent waves stop re-deriving rules)
- `4724ad5` — Tier 1: `writing-api-gate-spec`, `wiring-spec-into-gate`, `writing-vitest-unit-test`
- `d7b17b7` — Tier 2: `adding-admin-trigger-endpoint`, `bumping-version-docs`, `dispatching-parallel-agent-wave`
- `1b00dd8` — Visibility: `reporting-agent-progress` + backend `/api/developer/agent-activity` + Live Agent Activity widget on `/developer` page (polls every 3s)
- `67129bc` — Bug fix: `wire-in.sh` `tests/tests/` double-prepend (caught mid-wave)

**Phase 2 — G-20 tenant-isolation flagship** (29 resources / 93 cross-tenant assertions)
- `a9154ac` — Wave 1: 12 resources (deals/contacts/leads/tasks/notes/companies/etc.)
- `04e5b56` — rename-on-cleanup pattern for no-DELETE resources (`_teardown_<area>_<id>`)
- `8064fda` — Wave 2: +9 resources incl. wellness FK chain (Patient → Visit → Rx → Consent + workflows + sequences + projects + tickets + scheduled-emails)
- `561c8da` — fix-up: post-DELETE owner-read falls back to list lookup when route lacks GET /:id
- `f4b4ebe` — Wave 3: +8 resources (treatment-plans on the new canonical path, custom-objects entities CRUD, AuditLog, RecurringInvoices, Currencies, Scim, Tenants, Activities)

**Phase 3 — 5 audit-followup bug fixes** (closed)
- `5ca0849` #412 Campaign schedules persist in DB (was global._campaignSchedules)
- `51b299a` #416 backup engine respects MYSQLDUMP_BIN strictly
- `03071ff` #417 backup engine `spawn` pipe to observe both exit codes
- `2eb7dbc` #418 routes/workflows.js GET /:id
- `b90ac7c` + `1f5f35a` #419 routes/custom_objects entities GET/PUT/DELETE/:id + 'String' vocabulary
- `cea9bc0` #420 wellness treatments → /treatment-plans canonical path

**Phase 4 — R-4 medium-route batch + R-5 batch 2 cron-engine vitests**
- `c1c3b3d` attribution-api / `1cb1a93` document-templates-api / `9db1f26` email-threading-api / booking-pages-api
- `78082d0` forecastSnapshotEngine / `53e3299` leadScoringEngine / `76bf2a4` sentimentEngine / `4bcc98c` slaBreachEngine

**Phase 5 — T2.1 mobile sidebar drawer** (`590011d`) — overlay + backdrop + focus trap at <900px

### Per-push gate state

**~64 Playwright specs / ~2,237 tests + 35 vitest files / 677 unit tests = ~2,914 tests per push** (+18% vs v3.4.3). All green at HEAD `f4b4ebe`.

### Three things to do first next session

1. **Tag v3.4.4** — `git tag -a v3.4.4 -m "..."` + push tag. Fires e2e-full release-validation against demo. Doc bump (CHANGELOG / README / CLAUDE.md / this handoff / E2E_GAPS.md) is shipped in the same wave-finishing commit.

2. **G-20 wave 4 (final)** — remaining cross-tenant resources from E2E_GAPS.md status table not covered yet. Estimate ~3-4h, parallel-safe.

3. **G-21 frontend vitest+RTL setup** (3-5 days; 80 pages + 11 components have zero isolated tests). Now that the backend skill cohort is mature, frontend is the next big surface to build a corresponding skill set for.

### Issues open / new contract-drift findings

- #421, #422, #423 — surfaced by R-4 specs this session, queued for separate planning passes (drift in attribution / document-templates / email-threading state machines vs. spec-derived contracts)
- #413 — 49 models without `tenant Tenant @relation` (cascade leak on `Tenant.delete()`)
- #414 — `MarketplaceLead.@@unique([provider, externalLeadId])` excludes tenantId
- #415 — 21 `@@unique` constraints lack documenting comments
- T2.2 — Audit-log middleware build-out (4-5 days; Patient/Visit/Rx/Consent mutations)
- T2.3 — Ship P1 of regression backlog
- G-22 — Integration test tier (msw/nock) — Stripe webhook signing
- G-23 — Migration safety check (prisma migrate dry-run in CI)

---


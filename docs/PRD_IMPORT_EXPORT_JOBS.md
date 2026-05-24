# PRD — Import/Export Job History (Centralized Async Bulk-Data Operations)

**Status:** NOT STARTED — PRD draft only; design call needed before any code lands
**Source:** GH #850 — [Gap][IE-002] Import/Export job history page missing
**Tier:** P3 — Operator visibility + compliance traceability (no traffic-blocked workflow today, but every bulk-data operation runs blind)
**Authored:** 2026-05-25 (tick #189 / Agent B, autonomous overnight cron arc)
**Sibling PRDs:** `PRD_PURCHASE_ORDERS.md` (tick #187 — consumer of bulk supplier-master import), `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — sibling P2 governance surface)
**Cluster:** MANUAL_CODING_BACKLOG.md cluster D (wellness operational session) — proposing **D10**; see §10.
**Cred dependency:** none external; pure internal infra.

---

## §1 Background + source attribution

The CRM today has **no centralized history surface for bulk-data operations**. Per GH issue #850 verbatim:

> Audit Log exists but is not a true Import/Export history. The catalog Import/Export action itself is tracked in #816 [SVC-001], but there is no dedicated page that shows the history of import/export jobs (with status, file, row counts, errors).
>
> **Gap:**
> - No central page to view past import/export jobs.
> - No visibility into job status (queued/running/success/partial/failed).
> - No way to download the original file, the result file, or the error CSV for a past job.
> - No row-level error reporting persisted with the job.
>
> **Requirements:**
> - New `Import / Export History` page (under Settings or per-module).
> - Columns: Job ID, Type (Import/Export), Entity (Customers, Products, Bookings, Services, Vendors, etc.), Started by, Started at, Duration, Status, Rows total / processed / failed, Actions.
> - Actions: download original file, download result/error CSV, retry failed rows, view detailed log.
> - Filters: entity, type, status, date range, user.
> - Retention policy (e.g., keep job artifacts for N days, with size guardrails).
> - Role-gated: Admin/Owner; restricted view for module owners.
>
> **Impact:**
> - No traceability of bulk data operations — hard to debug failed imports.
> - Users cannot self-diagnose errors; ops must inspect logs.
> - No audit trail tying data changes to specific bulk jobs.
>
> **Notes:**
> - Distinct from #816 [SVC-001] which is about *enabling* import/export; this issue is about the *history* surface.

Today's bulk-data footprint in the codebase:

- **Wellness patient exports** at [backend/routes/wellness.js:497](../backend/routes/wellness.js#L497) (`GET /patients.csv`) + [backend/routes/wellness.js:584](../backend/routes/wellness.js#L584) (`GET /patients.xlsx`) — synchronous streaming downloads. Operator clicks → backend streams CSV/XLSX back over the same HTTP request → no record persisted that the export happened. Audit log captures the route hit but not "what was in the file" or "did the operator finish downloading it".
- **Wellness patient import template** at [backend/routes/wellness.js:705](../backend/routes/wellness.js#L705) (`GET /patients/import-template.csv`) — landed tick #189 (Agent A, same wave) — returns the column-header template for the upcoming patient-import flow. **There is no consuming `POST /patients/import` upload endpoint yet** — the template ships ahead of the upload-and-process path. THIS PRD covers the missing upload + async processing + history-tracking surface.
- **Travel CSV I/O** at [backend/routes/travel_csv_io.js](../backend/routes/travel_csv_io.js) — landed across `2840d46` + `769c484` for the travel-vertical itinerary + supplier import/export. Synchronous; no job-history records.
- **Generic CSV I/O** at [backend/routes/csv_io.js](../backend/routes/csv_io.js) (mounted at `/api/csv` per [backend/server.js:741](../backend/server.js#L741)) — services / products / membership-plans import+export. Synchronous; no job-history records.
- **Wellness inventory CSV** + per-module CSV endpoints scattered across `routes/billing.js`, `routes/contacts.js`, `routes/leads.js`, `routes/deals.js` — operator-triggered, synchronous, no history record.
- **Audit log** ([backend/routes/audit.js](../backend/routes/audit.js)) — captures route hits + state changes but is per-entity (Contact, Deal, Invoice, …), NOT per-job. An import that creates 500 Contacts produces 500 audit rows (one per CONTACT_CREATED event); there is no single "this import created 500 Contacts" parent record that ties them together.

### What's missing structurally

Today's piecemeal CSV/XLSX endpoints are **stateless** — request comes in, work happens, response goes out, nothing persists. This works fine for small datasets (a 20-row product export takes <1s; the operator stays on the page; nothing to history-track). It breaks down for:

1. **Large exports.** A 50,000-row patient export hits the HTTP request-timeout (or the operator's tab times out) before the CSV finishes streaming. Today the operator's only recourse is to filter the export to a smaller window + repeat 10x. There is no "queue this; I'll come back when it's ready" surface.
2. **Large imports.** A 5,000-row CSV upload to create patients takes 2-5 minutes to validate + insert. The HTTP request times out long before completion. Even when it doesn't, the operator gets no row-level feedback ("row 47 failed because the phone column had a typo; rows 48-end never processed").
3. **Compliance/DSAR audit.** Auditor asks "show me who exported PII from this tenant in the last 12 months". Today: no central record. Audit-log lookups by route-path show the GET hits but not the row-counts or whether the export was successful.
4. **Failed-import re-run.** Operator uploads a CSV; 47 rows fail due to validation errors; today the operator has no way to download "just the failed rows + error reasons" and fix-and-retry. They re-upload the full CSV (recreating the rows that already succeeded — duplicates) or they bisect manually.

### Prior art

- **HubSpot Imports** ([https://knowledge.hubspot.com/import/import-objects](https://knowledge.hubspot.com/import/import-objects)) — async upload + status tracking + per-row error report + 30-day artifact retention + a dedicated "Recent Imports" page.
- **Zoho CRM Imports** ([https://www.zoho.com/crm/help/import-data.html](https://www.zoho.com/crm/help/import-data.html)) — async upload + email-on-completion + per-row error file download + "Imports" tab under each module's setup.
- **Salesforce Data Loader** + **Salesforce Bulk API jobs** — first-class job entities with status/progress; long the gold standard for enterprise data import.
- **Globussoft sister product** Callified.ai has a similar pattern for bulk-lead-upload — every dispatched campaign keeps a job-row with success/failure/error-rows. The shape's been validated in-house.

### Why this is a P3, not a P1

The synchronous endpoints work today for the volumes Globussoft tenants currently see (wellness clinics import 50-500 patients during onboarding; export <5,000 rows for accounting purposes). The current pattern starts breaking when:

- A clinic chain migrates 20,000+ patients from a legacy system (Superphone/Zylu CSV export migration is a real near-term need per [project_wellness_client.md](../../.claude/projects/c--Users-Admin-gbs-projects-gbs-crm/memory/project_wellness_client.md)).
- Travel agencies pull historical bookings for compliance reporting (multi-year datasets routinely 50k+ rows).
- A DSAR request triggers a full-tenant PII export (every row of every PII-bearing table).

**The risk class is "no traceability + can't handle large datasets + no error-recovery for failed imports".** Material as scale ramps; not a hot fire today.

### Source attribution

- GH issue #850 — [https://github.com/Globussoft-Technologies/globussoft-crm/issues/850](https://github.com/Globussoft-Technologies/globussoft-crm/issues/850)
- Related: GH #816 — [SVC-001] Catalog import/export enablement (provides the per-module import/export endpoints THIS PRD wraps with async + history)
- Related: GH #820 — Patient import template + (forthcoming) patient bulk import endpoint
- Cross-reference: `PRD_PURCHASE_ORDERS.md` §7 ("Bulk PO operations — Create 20 POs from a CSV upload, mass-approve") — Phase 2 consumer of THIS PRD's job-history surface for the PO-bulk-create flow.
- Cross-reference: `PRD_TRAVEL_SUPPLIER_MASTER.md` (supplier CSV bulk-import flow already present at `travel_csv_io.js`; would migrate into the job system when this PRD ships).
- Cross-reference: Audit log + DSAR retention engine ([backend/cron/retentionEngine.js](../backend/cron/retentionEngine.js)) — THIS PRD's job-artifact retention follows the same pattern.

---

## §2 Use cases

1. **ADMIN bulk-imports 500 patients from a legacy CSV export.** Rishu's clinic-chain Owner navigates to `/wellness/patients` → clicks "Import Patients" → uploads a 500-row CSV (legacy Zylu export, manually mapped via the import-template generated at [routes/wellness.js:705](../backend/routes/wellness.js#L705)). System creates an `ImportExportJob` row in QUEUED state + stashes the uploaded CSV to disk (or S3 per DD-5.2). Operator navigates away. Cron-driven `importExportEngine` polls every 30s, picks up the QUEUED row, transitions to RUNNING, processes rows one-by-one against the registered PATIENT handler. 472 rows succeed; 28 rows fail (3 duplicate phone numbers + 25 missing date-of-birth). Job transitions to COMPLETED with `rowsSucceeded=472, rowsFailed=28`. Operator receives in-app notification + email "Patient import completed (472 succeeded, 28 failed)". Clicks notification → lands on Job History page → clicks the job row → sees "Download error report" → CSV with columns `rowNumber, errorCode, errorMessage, originalRow` — operator opens in Excel, fixes the 28 problem rows, re-uploads as a fresh import (28-row CSV). Second job runs in <30s.

2. **USER triggers a large dataset export (5000+ rows).** Reception staff (USER role) clicks "Export All Patients" from the patient list. System creates an `ImportExportJob` row in QUEUED state + records the operator's filter parameters in `params`. Engine picks up the row → streams patient rows to a temp CSV file → uploads file to disk/S3 → marks COMPLETED with `outputFileUrl` populated + `rowsSucceeded=5234`. Operator receives in-app notification "Your export is ready to download (5234 patients)". Clicks the notification → lands on Job History → clicks "Download" → CSV downloads. The job-history page also tracks `expiresAt` (30 days out by default per OQ-9.2) — after 30 days, the file is purged by a cleanup cron + the row transitions to EXPIRED with the download link grayed out.

3. **ADMIN reviews "who exported what when" for compliance/DSAR purposes.** Compliance auditor for a US-based wellness tenant requests a list of every PHI export from the last 12 months: who initiated, what filters were used, when, how many rows, what file. ADMIN navigates to `/settings/import-export-jobs` → filters Type=EXPORT, ResourceType=PATIENT, DateRange=last 12 months → exports the filtered job list as CSV. Each row tells the auditor exactly who (userId+name+email), when (startedAt+completedAt), what (resourceType+params filters), how many (rowsTotal). Cross-references the audit chain via `auditChainEntryId` FK on each job row (one audit row written per job state transition).

4. **A failed import shows a downloadable error file with row+column+reason for each rejected row.** Operator uploads a 200-row patient CSV. 47 rows fail validation (mix of missing required fields + duplicate phones + bad phone format + over-long names). Job transitions to COMPLETED with `rowsSucceeded=153, rowsFailed=47`. The PATIENT import handler streamed each failure into the in-memory error buffer + at end-of-run, persisted as an error CSV to `errorFileUrl`. Schema: `rowNumber,errorCode,errorMessage,originalRow` — `rowNumber` is the original-file row index (1-indexed, headers ignored); `errorCode` is a stable string (`PHONE_DUPLICATE`, `MISSING_REQUIRED:dateOfBirth`, `PHONE_FORMAT_INVALID`, etc.); `errorMessage` is a human-readable explanation; `originalRow` is the full original row content as a quoted CSV string. Operator opens the error report in Excel, fixes the 47 problem rows, saves as a fresh import — no need to filter out the 153 successes (they're not in the error file).

5. **Re-trigger an export from the history page.** Job from 35 days ago has EXPIRED (its `outputFileUrl` was purged by the cleanup cron at day 30). Operator needs the same export again with the same filters. Clicks "Re-run" on the expired row → system creates a fresh job (new ID) with `params` copied verbatim from the expired job + records `parentJobId` FK for audit linkage. Fresh job runs against current data (NOT historical — re-runs always pull current state); operator gets the latest snapshot.

6. **Cancellable in-flight job.** ADMIN realizes a 50,000-row export was kicked off against the wrong filter (entire-tenant instead of just-Mumbai-location). Opens Job History → clicks "Cancel" on the RUNNING row. Engine's per-row processing loop checks `job.status` between every 100 rows; when it observes CANCELLED, it bails out + persists `rowsSucceeded` to whatever it had processed + writes a partial output file (operator can download what was processed so far if useful) + transitions row to CANCELLED. Audit chain records the cancellation event + cancellingUserId.

7. **Failed-row retry (single-pass).** Operator's first import attempt yielded `rowsSucceeded=472, rowsFailed=28`. Instead of downloading the error CSV + manually editing + re-uploading, operator clicks "Retry Failed Rows" on the completed job. System reads the error file → for each row whose error is RETRYABLE (e.g. `RACE_DUPLICATE`, `TRANSIENT_DB_ERROR`), creates a fresh job containing only those rows + records `parentJobId` FK. Non-retryable errors (`PHONE_FORMAT_INVALID`, `MISSING_REQUIRED:*`) are excluded from the retry batch since they need operator data fixes. UI surfaces "12 of 28 failures are eligible for automatic retry; 16 require data fixes — download the error report and re-upload manually."

---

## §3 Functional requirements

### FR-3.1 ImportExportJob Prisma model (new)

**Schema (additive migration):**

```prisma
model ImportExportJob {
  id              Int      @id @default(autoincrement())
  tenantId        Int      @default(1)
  userId          Int                                       // Originator (FK to User)
  kind            String                                    // 'IMPORT' | 'EXPORT'
  resourceType    String                                    // 'PATIENT' | 'CONTACT' | 'LEAD' | 'DEAL' | 'INVOICE' | 'PRODUCT' | 'SERVICE' | 'VENDOR' | 'BOOKING' | future
  status          String   @default("QUEUED")               // 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED'
  inputFileUrl    String?  @db.Text                         // Stored path/URL of the uploaded CSV/XLSX (IMPORT only)
  outputFileUrl   String?  @db.Text                         // Stored path/URL of the result file (EXPORT or import-result-summary)
  errorFileUrl   String?  @db.Text                         // Stored path/URL of the per-row error CSV (IMPORT only)
  rowsTotal       Int?                                       // Pre-computed at job-start (IMPORT = uploaded row count; EXPORT = estimated)
  rowsSucceeded   Int?                                       // Live-incremented as engine processes
  rowsFailed      Int?
  params          Json?                                      // Filter params (for EXPORT) or import options (for IMPORT)
  errorSummary    String?  @db.Text                         // Top-level error message if FAILED at the job level (vs row-level)
  parentJobId     Int?                                       // FK to ImportExportJob for retry/re-run lineage
  auditEntryId    Int?                                       // FK to AuditLog row at job-creation (audit-chain linkage)
  startedAt       DateTime?
  completedAt     DateTime?
  expiresAt       DateTime?                                  // Auto-set at job-create via Tenant.jobArtifactRetentionDays (default 30)
  cancelledBy     Int?                                       // FK to User if status=CANCELLED
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  tenant          Tenant   @relation(fields: [tenantId], references: [id])
  user            User     @relation("ImportExportJobCreator", fields: [userId], references: [id])
  parent          ImportExportJob? @relation("JobLineage", fields: [parentJobId], references: [id])
  children        ImportExportJob[] @relation("JobLineage")

  @@index([tenantId, status, createdAt])
  @@index([tenantId, userId, createdAt])
  @@index([tenantId, resourceType, kind, createdAt])
  @@index([status, expiresAt])                              // For the cleanup cron's scan
}
```

The `@@unique` constraint is intentionally absent — a tenant can have unlimited jobs across time. The `@@index` set is shaped for the dominant query patterns: list-by-tenant-filter (status / user / resourceType), and the cleanup cron's "find expired jobs" scan.

**Tenant.jobArtifactRetentionDays:** new additive field on Tenant, default 30. Tenants can extend (e.g. to 90 days for compliance-heavy environments) or shrink (e.g. 7 days for storage-constrained environments).

### FR-3.2 Cron-driven engine (new `backend/cron/importExportEngine.js`)

- **FR-3.2.a Polling cadence.** 30-second tick (between job pickup latency target of ~30s + the 22 existing engines' aggregate load on the cron scheduler). Configurable via env-var `IMPORT_EXPORT_ENGINE_INTERVAL_MS=30000`.
- **FR-3.2.b Per-tick work.** On tick: scan `where: { status: 'QUEUED' } orderBy: createdAt asc take: 5` (process up to 5 jobs per tick, FIFO); for each:
  1. Transition to RUNNING with `startedAt = now`.
  2. Look up the resource-type handler via the registry (FR-3.3).
  3. Call the handler with `(job, prisma, contextHelpers)`. Handler is responsible for reading input file (IMPORT) or streaming output rows (EXPORT) + updating `rowsSucceeded` / `rowsFailed` incrementally + persisting the result file + writing audit entries per row (NOT per job — row-level audit-chain entries scale poorly; use the job-summary entry only).
  4. On handler success: transition to COMPLETED with `completedAt = now` + final row counts + `outputFileUrl` / `errorFileUrl` populated.
  5. On handler throw: transition to FAILED + write `errorSummary` with the exception message (stack trace logged but not persisted to DB).
  6. On observed status=CANCELLED mid-processing (handler periodically refetches): handler bails cleanly + transition stays CANCELLED.
- **FR-3.2.c Concurrency control.** Per-tenant concurrency cap (`Tenant.maxConcurrentJobs: Int @default(2)`) — only 2 RUNNING jobs per tenant at any time. Prevents one tenant's 50,000-row export from blocking other tenants' QUEUED jobs (cooperative fairness across tenants).
- **FR-3.2.d Stuck-job detection.** Jobs in RUNNING state for >1 hour (configurable via env) without progress (`updatedAt` stale) are marked FAILED with `errorSummary='Stuck — exceeded max runtime; possible engine crash'`. Operator can re-run.
- **FR-3.2.e DISABLE_CRONS=1 honors v3.2.2 pattern.** When env-var set, engine doesn't initialize on server boot. Matches the 22 other cron engines' behavior per [CLAUDE.md](../CLAUDE.md) standing-rule.

### FR-3.3 Resource-type handler registry (`backend/lib/importExportRegistry.js`, new)

- **FR-3.3.a Registry shape.** Module exports:
  ```js
  const handlers = new Map();  // resourceType -> { importHandler, exportHandler, displayName, schema, canRetry }
  function registerHandler(resourceType, config) { ... }
  function getHandler(resourceType) { ... }
  function listHandlers() { ... }
  ```
- **FR-3.3.b Handler contract.** Each handler is a `{ importHandler(job, ctx), exportHandler(job, ctx) }` pair. Either may be omitted (e.g. a resource type may be export-only — INVOICE is a candidate since invoices SHOULD NOT be bulk-imported; or import-only — rare). Context object provides `prisma`, `tenantId`, `userId`, `progressTick(rowsSucceeded, rowsFailed)`, `appendErrorRow(rowNumber, errorCode, errorMessage, originalRow)`, `writeOutputRow(rowObj)`, `checkCancelled()` (returns boolean).
- **FR-3.3.c Initial v1 handler set.**
  - **PATIENT** — IMPORT + EXPORT. IMPORT validates phone + DOB + name; idempotent on phone (insert-on-new, skip-with-warning on duplicate per OQ-9.x). EXPORT mirrors the existing `/patients.csv` synchronous endpoint's column set (canonicalize the column ordering BEFORE this PRD ships — the existing route should match the import-template).
  - **CONTACT** — IMPORT + EXPORT. Generic CRM contact import; reuses existing `routes/contacts.js` insert path under the engine's batch wrapper.
  - **LEAD** — IMPORT + EXPORT. Marketplace-lead-style ingestion.
  - **DEAL** — EXPORT only. Importing deals is high-risk (deal stage + value + ownership are pipeline-shaped; bulk-import without owner notification creates audit/attribution chaos). Operator does deal-level imports via the existing Sales Excel template if needed; the bulk-import flow stays out of v1.
  - **PRODUCT** — IMPORT + EXPORT. Mirrors the existing `routes/csv_io.js` shape.
  - **SERVICE** — IMPORT + EXPORT. Wellness service catalog; mirrors existing `csv_io.js`.
  - **VENDOR** — IMPORT + EXPORT. Wellness vendor master.
  - **INVOICE** — EXPORT only. Bulk-importing invoices is finance-grade and out of v1.
- **FR-3.3.d Extensibility.** Adding a new resource type is: (1) write a handler module under `backend/lib/importExport/<resource>.js`; (2) register it in `importExportRegistry.js`. Zero UI changes — the admin page lists resource types from the registry. Future candidates: BOOKING (travel), CALL_LOG (telephony bulk-import for migration), CAMPAIGN (marketing-side bulk audience upload).

### FR-3.4 API endpoints (new `backend/routes/import_export_jobs.js`)

All under `/api/import-export-jobs`. JWT-guarded; RBAC per FR-3.7.

- **FR-3.4.a `POST /api/import-export-jobs`** — Create new job. Body: `{ kind, resourceType, params, file? }` (file is multipart for IMPORT). Validates: `kind ∈ ['IMPORT','EXPORT']`, `resourceType ∈ registered handlers`, importer-only-for-kind=IMPORT, file required for IMPORT + absent for EXPORT, file ≤25MB (configurable cap per OQ-9.x). Creates row in QUEUED + stashes file to disk/S3 + writes audit entry + returns the new job row. Per-tenant scoped via `req.user.tenantId`.
- **FR-3.4.b `GET /api/import-export-jobs`** — List with filters. Query: `kind?`, `resourceType?`, `status?`, `userId?` (ADMIN only — others scoped to self), `from?`, `to?`, `limit?` (default 25, max 100), `offset?`. Returns rows + total count + the resolved `displayName` from the registry for each `resourceType`.
- **FR-3.4.c `GET /api/import-export-jobs/:id`** — Detail view. Returns the row + signed download URLs for `inputFileUrl` / `outputFileUrl` / `errorFileUrl` (signed because the underlying storage may be S3; even local disk, signed via a TTL'd token).
- **FR-3.4.d `POST /api/import-export-jobs/:id/cancel`** — Cancel a QUEUED or RUNNING job. Sets `status=CANCELLED, cancelledBy=req.user.userId`. The engine handler observes status mid-loop + bails. Cancellation of already-COMPLETED / FAILED / EXPIRED jobs returns 409.
- **FR-3.4.e `POST /api/import-export-jobs/:id/retry`** — Retry-failed-rows. Reads the error file from the parent job, filters to RETRYABLE error codes (handler-specified), creates a fresh job with `parentJobId = <orig.id>` containing only the retryable rows. Returns the new job row.
- **FR-3.4.f `POST /api/import-export-jobs/:id/rerun`** — Re-run with same params. Creates fresh job; for EXPORT, re-pulls current data; for IMPORT, this is forbidden (an import-rerun would create duplicates — the operator must explicitly create a new job).
- **FR-3.4.g `GET /api/import-export-jobs/:id/download/:fileKind`** — Download a job's input/output/error file. `fileKind ∈ ['input','output','error']`. Validates the file exists + the job's tenantId matches `req.user.tenantId` + RBAC per FR-3.7. Streams the file with appropriate `Content-Disposition: attachment`. EXPIRED jobs return 410 Gone with a hint to "click Re-run to regenerate".
- **FR-3.4.h `GET /api/import-export-jobs/handlers`** — List registered resource types (from the registry). Used by the frontend to populate the "What do you want to import/export?" dropdown. Returns `[{ resourceType, displayName, supportsImport, supportsExport, canRetry }, ...]`.

### FR-3.5 Job-history admin page (frontend)

New page `frontend/src/pages/ImportExportJobs.jsx`. Route: `/settings/import-export-jobs` (admin-mounted) + per-resource shortcut surfaces (e.g. `/wellness/patients` exposes a "Recent Imports" link in the page header).

Layout:
- **Top filter bar.** Filter chips: Kind (Import / Export) + Resource Type (dropdown sourced from `/handlers`) + Status (multi-select QUEUED/RUNNING/COMPLETED/FAILED/CANCELLED/EXPIRED) + Date Range + User (ADMIN only) + a "Show My Jobs" toggle (default ON for non-ADMIN; OFF for ADMIN).
- **Job table.** Columns per #850's spec: Job ID, Type, Entity (resourceType display name), Started by (userName + email), Started at, Duration, Status badge, Rows total / processed / failed (formatted "472 ok / 28 failed of 500 total"), Actions menu.
- **Actions menu per row.** "View details" (drawer with full job metadata + params JSON viewer); "Download original" (IMPORT only); "Download result" (EXPORT only); "Download error report" (IMPORT only, COMPLETED/FAILED only); "Retry failed rows" (IMPORT only, COMPLETED with rowsFailed>0); "Re-run" (any terminal state); "Cancel" (QUEUED or RUNNING only).
- **Live-update.** Page polls `/api/import-export-jobs?status=QUEUED,RUNNING` every 10s while any RUNNING jobs are visible. Once all complete, polling stops. (No web-socket; HTTP polling is simpler + good enough for this volume.)
- **New-job button.** Top-right "+ New Job". Opens a 2-step modal:
  1. Pick kind (Import / Export) + resource type.
  2. For IMPORT: file upload + optional params (e.g. "skip duplicates" toggle). For EXPORT: filter form (resource-type-specific, but always includes date-range + optional resource-type filter).
- **Empty-state.** "No jobs yet for this tenant. Click 'New Job' to start an import or export."

### FR-3.6 Notifications

- **FR-3.6.a In-app notifications.** On job COMPLETED / FAILED / CANCELLED, fire an in-app `Notification` row via existing `backend/lib/notificationService.js`. Title: "Your patient import is complete (472 ok, 28 failed)". Body: link to the job-detail page. Category: `'import-export'` (new category — adds to the existing taxonomy under `notify({ category })`).
- **FR-3.6.b Email-on-completion.** Default ON for jobs that take >1 minute (heuristic threshold) — operator likely navigated away. Configurable per-user via `User.emailOnJobCompletionPreference: Boolean @default(true)`. Email body includes job-summary stats + a deep-link to the job-detail page.
- **FR-3.6.c No SMS / WhatsApp by default.** Job-completion notifications are low-urgency; in-app + email is sufficient. Per OQ-9.x, tenants can opt-in to SMS or WhatsApp on FAILED only (a failed import is operator-blocking).

### FR-3.7 RBAC

- **FR-3.7.a USER role.** Can create / view / cancel / re-run / retry **their own** jobs. Cannot see other users' jobs.
- **FR-3.7.b MANAGER role.** Can view all jobs in their tenant + cancel any tenant job + cannot run as another user (job's `userId` is always `req.user.userId`).
- **FR-3.7.c ADMIN role.** All MANAGER permissions + can re-run any job + can extend a job's `expiresAt` (postpone purge by N days, max 90).
- **FR-3.7.d Resource-type sub-permissions.** Some resource types are restricted at the handler level — e.g. PATIENT (PHI) exports require `verifyWellnessRole(['doctor','professional','telecaller'])` per the existing wellness-PHI gate. The handler-registry exposes a `requireRoles` array per resource type; route enforces before queueing the job.
- **FR-3.7.e Audit-trail visibility.** All ADMIN + MANAGER can see the full job-history table (the "who exported what when" use case). This is intentionally broader than the create/cancel permission set so the audit role works at MANAGER tier.

### FR-3.8 Error report format

The error CSV (`errorFileUrl`) carries 4 columns:
- **rowNumber** — 1-indexed integer; matches the original CSV's row index (header is row 1; first data row is row 2).
- **errorCode** — stable string id. Convention: `<CATEGORY>:<DETAIL>`. Examples:
  - `MISSING_REQUIRED:dateOfBirth`
  - `PHONE_FORMAT_INVALID`
  - `PHONE_DUPLICATE` (within the import file itself)
  - `RACE_DUPLICATE` (another concurrent import created the row first; RETRYABLE)
  - `FIELD_TOO_LONG:firstName`
  - `INVALID_ENUM:gender`
  - `FK_NOT_FOUND:locationId`
  - `TRANSIENT_DB_ERROR` (RETRYABLE)
  - `UNKNOWN` (catch-all; not retryable)
- **errorMessage** — human-readable explanation. Example: "Phone number '+91-98abc-12345' is not a valid phone format. Use international format like +919812345678."
- **originalRow** — the full original row content as a CSV-quoted string. Lets the operator open the error report in Excel + see exactly what failed without cross-referencing the original upload.

Retryable error codes are declared per-handler. The retry flow (FR-3.4.e) filters to retryable rows only.

### FR-3.9 File storage

- **FR-3.9.a Default: local disk.** Files stashed under `<repo>/uploads/import-export-jobs/<tenantId>/<jobId>/<filename>`. Path is `.gitignored` (already covered by `uploads/` in `.gitignore`).
- **FR-3.9.b Pluggable to S3.** A storage-abstraction layer (`backend/lib/jobFileStorage.js`, new) exposes `{ saveFile(buf, key), getSignedDownloadUrl(key, ttl), deleteFile(key), fileExists(key) }`. Default impl is local-disk; S3 impl ships behind feature-flag `JOB_FILES_STORAGE=s3` + env-vars `AWS_S3_BUCKET / AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY`. Production tenants can opt into S3 without code changes.
- **FR-3.9.c Signed URLs.** Even for local-disk storage, the download endpoint (`FR-3.4.g`) is JWT-guarded; the path is opaque (`/api/import-export-jobs/:id/download/:fileKind`) — operators never see filesystem paths directly. S3 mode swaps in signed S3 URLs returned to the client.
- **FR-3.9.d Size cap.** Hard cap on uploaded files: 25MB by default (configurable per-tenant via `Tenant.maxImportFileBytes`). 25MB is ~50,000 rows of typical CSV; sufficient for v1. Above-cap uploads return 413 Payload Too Large at the multer middleware layer.

### FR-3.10 Retention + cleanup cron

- **FR-3.10.a `expiresAt`.** Auto-set at job-create: `expiresAt = now + Tenant.jobArtifactRetentionDays * 86400e3` (default 30 days).
- **FR-3.10.b Cleanup cron.** New `backend/cron/jobArtifactCleanupEngine.js`. Runs daily 03:30 IST. Scans `where: { status: { in: ['COMPLETED','FAILED','CANCELLED'] }, expiresAt: { lt: now } }` → for each:
  1. Delete the `inputFileUrl` / `outputFileUrl` / `errorFileUrl` files from storage.
  2. Set `inputFileUrl=null, outputFileUrl=null, errorFileUrl=null` on the row.
  3. Transition `status='EXPIRED'`.
  4. Keep the row + its metadata indefinitely (or per separate audit-retention sweep — DD-5.6 covers).
- **FR-3.10.c Retention-extension.** ADMIN can extend an individual job's `expiresAt` from the UI ("Keep this job's files for another 30 days") up to a hard max of `now + 90 days` to prevent runaway disk usage.

### FR-3.11 Audit log integration

Audit chain entries (via `backend/lib/audit.js` `writeAudit(entity, action, entityId, userId, tenantId, details)`):

- `IMPORT_EXPORT_JOB` + `CREATED` — on POST; details = `{ kind, resourceType, fileBytes?, paramsKeys }` (params keys only, not values — params may carry PII filters).
- `IMPORT_EXPORT_JOB` + `STARTED` — on QUEUED → RUNNING transition (engine writes); details = `{ rowsTotal? }`.
- `IMPORT_EXPORT_JOB` + `COMPLETED` — on COMPLETED transition; details = `{ rowsSucceeded, rowsFailed, durationMs }`.
- `IMPORT_EXPORT_JOB` + `FAILED` — on FAILED transition; details = `{ errorSummary, rowsSucceeded, rowsFailed, durationMs }`.
- `IMPORT_EXPORT_JOB` + `CANCELLED` — on CANCELLED transition; details = `{ cancelledBy, rowsSucceeded, rowsFailed, durationMs }`.
- `IMPORT_EXPORT_JOB` + `EXPIRED` — on cleanup-cron purge; details = `{ filesDeleted: [...] }`.
- `IMPORT_EXPORT_JOB` + `RETRY_TRIGGERED` — on retry; details = `{ parentJobId, retryRowCount }`.
- `IMPORT_EXPORT_JOB` + `RERUN_TRIGGERED` — on re-run; details = `{ parentJobId }`.
- `IMPORT_EXPORT_JOB` + `EXPIRY_EXTENDED` — on operator extension; details = `{ oldExpiresAt, newExpiresAt }`.

Audit chain inherits the existing hash-chain immutability. `/api/audit/verify` works against IMPORT_EXPORT_JOB entries with zero code changes.

---

## §4 Non-functional

- **Per-tenant scoping.** Every job row carries `tenantId` (FK to Tenant). Every route handler + engine handler scopes by tenantId. Cross-tenant access impossible. Mirrors every other CRM route's tenantWhere pattern. ESLint rule blocks `req.body.tenantId` reads.
- **File storage abstraction.** Local disk by default; pluggable to S3 via storage shim (FR-3.9). Engine + routes are storage-agnostic.
- **Job expiry + cleanup cron.** Daily 03:30 IST sweep purges expired job artifacts. Configurable retention window per-tenant (default 30d, max 90d).
- **Audit log.** All state transitions write to the tamper-evident audit chain.
- **Engine concurrency.** Max 5 concurrent jobs across all tenants per engine tick; max 2 concurrent jobs per tenant. Prevents one tenant's heavy import from monopolizing the engine.
- **Engine resilience.** Stuck jobs (RUNNING >1h with no progress) auto-fail. Engine crashes don't lose jobs (state is durable in DB). Server restart picks up QUEUED jobs on the next tick.
- **Performance — list endpoint.** Tenant with up to 10,000 historical jobs paginates to first-page-load <500ms via the `(tenantId, status, createdAt)` index.
- **Performance — engine tick.** Each tick processes up to 5 jobs in <1s of overhead (the per-row work is the dominant cost). Engine startup latency <100ms.
- **Performance — large imports.** A 5,000-row patient import target: <2 minutes end-to-end (P50). 50,000-row import target: <20 minutes (P50). Operator-visible progress via the engine's per-batch `progressTick`.
- **PHI gating on patient handlers.** PATIENT IMPORT + EXPORT both check `verifyWellnessRole` at job-create time. Cross-professional patient exports are restricted per the existing wellness-PHI rules.
- **Disk-space guardrails.** Storage shim tracks total bytes per tenant; soft-warn at 80% of `Tenant.maxJobStorageBytes` (default 5GB); hard-block POST at 100% (returns 507 Insufficient Storage with a hint to delete old jobs).
- **DISABLE_CRONS=1 honors v3.2.2 pattern.** Engine doesn't initialize when env-var set. Aligns with the 22 existing engines.
- **Graceful SIGTERM shutdown.** Engine in-flight jobs receive a signal + persist current state to DB + transition to QUEUED (not FAILED — they can be retried on next boot). Aligns with the v3.2.2 c8 V8 coverage-flush requirement.

---

## §5 Hand-over reqs / cred chase / design decisions / vendor docs

### Design decisions (require product / security-team sign-off before backend impl can start)

- **DD-5.1 Single ImportExportJob table OR separate ImportJob + ExportJob tables?** Two paths:
  - **(a) SINGLE table with `kind` discriminator.** Simpler; one model; one route file; one engine. The `kind` field discriminates IMPORT/EXPORT for handler dispatch. Most fields are shared (status, rowsTotal/Succeeded/Failed, errorFileUrl, params, expiresAt, audit linkage).
  - **(b) FORK to two tables.** Cleaner type semantics; the `inputFileUrl` only makes sense for IMPORT + the `outputFileUrl` only for EXPORT. Trade: two routes + two engines + the parentJobId FK becomes harder (cross-table lineage).
  **Recommendation: (a) SINGLE TABLE.** Mirrors the `PRD_PURCHASE_ORDERS.md` DD-5.1 single-model-with-discriminator pattern (PO with `purpose: 'INVENTORY' | 'TRAVEL'`). Imports and exports share enough structure that the shared table wins on maintenance simplicity. The handler-registry abstracts the per-kind logic anyway.
- **DD-5.2 Synchronous-import-with-progress (SSE) OR queue-and-notify?** Two interaction patterns:
  - **(a) SSE — sync with progress stream.** Operator stays on the upload page; the server streams progress events (`{rowsProcessed, currentRow, currentStatus}`) over Server-Sent Events; UI shows a live progress bar. Pro: operators get immediate feedback; lower perceived latency. Con: tab-close mid-import is now a deserter scenario; backend must guard against half-uploads.
  - **(b) Queue-and-notify.** Operator uploads → backend queues the job + returns 202 Accepted → operator navigates away → engine processes async → notification on completion. Pro: tab-close-safe; engine fully owns the lifecycle; matches Salesforce/HubSpot/Zoho prior art. Con: operator has to context-switch back to the job-history page; bigger perceived latency for small imports.
  **Recommendation: (b) QUEUE-AND-NOTIFY.** Aligns with the use-case framing in #850 ("dedicated history page" implies the async model). SSE-progress can be a Phase 2 enhancement for the new-job modal if operator feedback requests faster feedback for small imports. Hybrid escape hatch: for imports ≤100 rows, the modal stays open + polls the job status every 1s until COMPLETED (effectively sync UX with async backend); above 100, modal closes immediately on upload + leaves the rest to notifications.
- **DD-5.3 Which existing CSV/XLSX endpoints get migrated INTO the job system vs stay direct-download?** Two paths:
  - **(a) MIGRATE ALL.** Every existing CSV/XLSX endpoint becomes a queue-job creator. Pro: uniform UX + uniform audit. Con: breaks existing operator habits — clicking "Export Patients" no longer downloads a file; it queues a job + the operator waits.
  - **(b) MIGRATE THRESHOLD.** Endpoints stay direct-download for small datasets; queue-jobs for large. Threshold: anything that would produce >1000 rows goes async; smaller stays sync. Pro: small-data operators see no UX change; large-data operators (the ones who NEED the history surface) get it.
  - **(c) MIGRATE NONE.** New job system is opt-in via a separate "Bulk Import/Export" page; existing endpoints unchanged. Pro: zero migration risk. Con: bifurcates the UX — operators have to know which entrypoint to use.
  **Recommendation: (b) MIGRATE THRESHOLD.** The threshold can be per-resource-type (PATIENT: 1000 rows; INVOICE: 500 rows; LEAD: 5000 rows). Existing route at endpoint counts rows BEFORE streaming; if above threshold, returns 202 with a new-job redirect; if below, streams sync. Phased migration over 2-3 releases — first ship the job system + page; second release adds the threshold-check on existing endpoints; third release deprecates sync endpoints above the threshold.
- **DD-5.4 Engine concurrency — process-local or distributed lock?** Today the CRM runs on a single backend instance (PM2 with a single worker). Engine concurrency is process-local — the in-process queue plus DB SELECT FOR UPDATE on QUEUED rows handles it. If Globussoft ever scales to multi-instance + horizontally-shared MySQL, the engine needs a distributed lock (Redis / DB-row-lock pattern). **Recommendation: PROCESS-LOCAL for v1**; flag distributed-lock as a Phase 2 prerequisite for multi-instance scaling. Document the assumption in engine source.
- **DD-5.5 PHI gate on patient exports — operator-attests OR system-blocks?** Two patterns:
  - **(a) Operator attests at job-create.** UI checkbox: "I acknowledge I'm exporting PHI; this export will be logged for compliance review." No system block; trust + audit-trail.
  - **(b) System blocks unless role permits.** PATIENT EXPORT requires `verifyWellnessRole(['doctor','professional','admin'])` per FR-3.7.d. Telecaller/USER roles see "Patient exports require Admin permission" + a request-form to ADMIN.
  **Recommendation: BOTH (b) + (a) layered.** Role-gate at the backend (b) is mandatory; the operator-attest checkbox (a) layers on top for additional audit-trail evidence. The audit entry's `details.attestedToPHI: boolean` captures the attestation.
- **DD-5.6 Job-row retention — indefinite OR finite?** The job METADATA (status, row counts, params, who+when) is small (one row ~500 bytes). The job FILES (inputs/outputs/errors) can be large (MB-GB). Recommendation: **METADATA indefinite + FILES finite (default 30d)**. The history page works forever; just the downloadable files expire. Tenants with stricter retention can shrink the file-retention window; tenants with looser can extend up to 90d.
- **DD-5.7 Cancellable in-flight jobs — soft OR hard?** Two cancellation semantics:
  - **(a) Soft cancel.** Engine handler observes `job.status` between row batches + bails on next batch boundary. In-flight rows in the current batch complete. Pro: predictable state; no half-row corruption. Con: cancel takes effect within seconds/minutes, not instantly.
  - **(b) Hard cancel.** Engine kills the worker mid-batch via async abort signal. Pro: instant cancel. Con: half-row state possible; corruption risk; harder to reason about partial-failure mode.
  **Recommendation: (a) SOFT CANCEL.** Predictability wins. The cancel-latency is acceptable (the engine checks status every 100 rows ~ every 5-10s).
- **DD-5.8 Bulk-update flow (UPDATE rows, not just CREATE)?** Two operator needs:
  - **(a) CREATE-only IMPORT.** Operator imports a CSV; system inserts new rows. Duplicates (matched on a key field like phone for Patient) are skipped + reported as warnings.
  - **(b) UPSERT IMPORT.** Operator imports a CSV; system inserts new rows + updates existing rows matched on a key. Pro: enables bulk-edit workflows. Con: enables bulk-corruption + auditing-row-changes-from-CSV is hard.
  **Recommendation: CREATE-only for v1; UPSERT in v2.** Defer the bulk-edit surface until the basic create-flow is stable. UPSERT in v2 adds a per-handler `keyField` + a per-row "matched existing; updated N fields" status + per-field audit entries.

### Cred chase

- **None external.** Pure internal infra. No third-party API. No new SaaS dependency for v1.
- **For S3 mode (Phase 1.5):** AWS account + S3 bucket + IAM credentials. Defer until a tenant requests S3 storage explicitly; demo+production start with local-disk.
- **Mailgun / Nodemailer (existing).** Used for email-on-completion notifications. No new credentials.

### Vendor docs

- N/A. No vendor integration in v1.
- **Pluggable backend storage interface follows the existing `backend/services/landingPageRenderer.js` + `backend/lib/webhookDelivery.js` shape** — abstract enough that S3 (or any S3-compatible like MinIO/DigitalOcean Spaces) drops in via a per-env config flag.

---

## §6 Acceptance criteria

- **AC-6.1** Operator (USER role) uploads a 100-row patient CSV via the new-job modal → backend creates `ImportExportJob` row in QUEUED state + persists the file → returns 202 Accepted with the new job ID. Within 30s, engine picks up the job + transitions to RUNNING + processes rows + transitions to COMPLETED with correct `rowsSucceeded` + `rowsFailed`. Operator receives in-app notification + (because the job took >60s) email on completion.
- **AC-6.2** Operator clicks "Export All Patients" with no filters from `/wellness/patients` (assuming patient count >1000) → backend creates EXPORT job in QUEUED + returns 202 + redirects operator to job-history page with the new job highlighted. Engine processes → marks COMPLETED with `outputFileUrl` populated. Operator clicks "Download result" → CSV downloads via signed JWT-guarded URL.
- **AC-6.3** Operator (ADMIN) opens `/settings/import-export-jobs` → filters Type=EXPORT, ResourceType=PATIENT, DateRange=last 12 months → table shows all matching jobs with userName/userEmail/startedAt/rowsTotal. Audit trail accessible by clicking any row.
- **AC-6.4** Failed import (47 of 200 rows fail validation) yields a downloadable error CSV with 47 rows × 4 columns (`rowNumber, errorCode, errorMessage, originalRow`). Operator downloads + fixes 47 rows in Excel + re-uploads as a fresh import → second job runs cleanly.
- **AC-6.5** Operator on a COMPLETED job with `rowsFailed=28` clicks "Retry Failed Rows" → system reads the error file + filters to RETRYABLE-coded rows (say 12 of 28) → creates a fresh job with only those 12 rows + `parentJobId` FK populated → engine processes; 12 rows succeed on the retry (race-condition fluke resolved). UI surfaces the retry-job + the audit linkage to the parent.
- **AC-6.6** ADMIN clicks "Cancel" on a RUNNING job → status transitions CANCELLED + cancelledBy populated + engine observes within next 5-10 seconds + bails gracefully + persists `rowsSucceeded` to wherever it had reached.
- **AC-6.7** Job-artifact cleanup cron runs at 03:30 IST → identifies 12 jobs with `expiresAt < now` + COMPLETED status → deletes each file from storage + nulls the URL fields + transitions to EXPIRED. Audit chain logs each expiry event. The history page renders EXPIRED rows with grayed-out download links + a "Re-run" action available.
- **AC-6.8** USER role attempts `GET /api/import-export-jobs?userId=42` (someone else's userId) → 403 Forbidden (RBAC). USER attempts `POST /api/import-export-jobs/:id/cancel` on another user's job → 403 Forbidden. MANAGER attempts both → 200 OK.
- **AC-6.9** PATIENT export by a `wellnessRole=helper` user → 403 with "Patient exports require Doctor / Professional / Admin role" (per FR-3.7.d + DD-5.5). Same user can still export VENDOR or SERVICE (which have no PHI gate).
- **AC-6.10** Audit chain integrity verified post-flow: `GET /api/audit/verify?entity=IMPORT_EXPORT_JOB` returns 200 with `integrityVerified=true` after 50 mixed jobs across 10 tenants. Cross-tenant access blocked end-to-end.

---

## §7 Out of scope

- **Scheduled recurring exports.** "Export all patients every Monday at 09:00" — separate from on-demand jobs; tracked via the existing `ReportSchedule` entity (which already has Mailgun delivery built in). Out of v1; integration point in Phase 2 (a scheduled-report can create an EXPORT job under the hood).
- **Two-way sync with external systems** (e.g. bidirectional sync with HubSpot, Pipedrive, Salesforce). Separate `Integration` system; out of v1.
- **AI-driven column-mapping for messy CSVs.** Operator pastes an arbitrary CSV; AI detects "this column is firstName, this is phone, this looks like a custom field". Phase 2; non-trivial AI prompt engineering + per-resource-type schema awareness.
- **Bulk UPDATE flow (UPSERT IMPORT).** Per DD-5.8 — CREATE-only in v1; UPSERT in v2.
- **Server-Sent Events progress streaming.** Per DD-5.2 — queue-and-notify in v1; SSE-progress for small imports in Phase 2.
- **Per-tenant job-storage S3 bucket selection.** v1 ships local-disk + global S3 (one bucket for all tenants per the env-var). Per-tenant bucket isolation is Phase 2.
- **Multi-file imports.** Operator wants to upload 3 CSVs + the system merges them. Out of v1; operator uploads sequentially.
- **Format conversion** (e.g. upload XLSX, export back as CSV; or import JSON; or import via API instead of file). v1 is CSV + XLSX input/output only.
- **Validate-only mode** (operator uploads, sees what WOULD fail, decides whether to commit). Out of v1; flag for Phase 2 — useful for high-stakes datasets.
- **Job-priority queueing.** All jobs FIFO by `createdAt`. No "URGENT" priority that jumps the queue. Out of v1.
- **Multi-tenant resource-sharing imports** (e.g. "import these 500 contacts into both Tenant T1 and Tenant T2"). Out of v1; tenant isolation is hard-locked.

---

## §8 Dependencies

- **`backend/cron/` engine pattern** — 22 existing engines listed in [CLAUDE.md](../CLAUDE.md). New `importExportEngine.js` follows the same shape (node-cron scheduling + `DISABLE_CRONS=1` env-respect + graceful SIGTERM).
- **`backend/lib/notificationService.js`** ([backend/lib/notificationService.js](../backend/lib/notificationService.js)) — Used for in-app + email notifications on completion. New `category: 'import-export'` added to the existing taxonomy.
- **`backend/lib/audit.js` `writeAudit()`** ([backend/lib/audit.js](../backend/lib/audit.js)) — Audit-chain integration. New entity `'IMPORT_EXPORT_JOB'` written transparently; hash chain inherits.
- **`backend/routes/wellness.js`** ([backend/routes/wellness.js:497](../backend/routes/wellness.js#L497)) — Existing `/patients.csv` + `/patients.xlsx` + `/patients/import-template.csv` endpoints. THIS PRD's PATIENT handler reuses the SQL+CSV/XLSX construction code as a library function (refactored out of the route). Migration follows the DD-5.3 threshold rule.
- **`backend/routes/csv_io.js`** + **`backend/routes/travel_csv_io.js`** — Existing CSV I/O routes for generic + travel verticals. THIS PRD's PRODUCT / SERVICE / VENDOR / membership-plans handlers reuse their construction code as library functions.
- **`Tenant` model** ([backend/prisma/schema.prisma](../backend/prisma/schema.prisma)) — New additive fields: `jobArtifactRetentionDays: Int @default(30)` + `maxConcurrentJobs: Int @default(2)` + `maxImportFileBytes: Int @default(26214400)` (25MB) + `maxJobStorageBytes: BigInt @default(5368709120)` (5GB).
- **`User` model** — New additive field: `emailOnJobCompletionPreference: Boolean @default(true)`.
- **New file `backend/lib/jobFileStorage.js`** — Storage abstraction (local-disk default; S3 plug).
- **New file `backend/lib/importExportRegistry.js`** — Handler registry + handler-contract interface.
- **New file `backend/lib/importExport/<resource>.js`** — Per-handler module (PATIENT, CONTACT, LEAD, DEAL, PRODUCT, SERVICE, VENDOR, INVOICE).
- **New file `backend/cron/importExportEngine.js`** — The polling engine.
- **New file `backend/cron/jobArtifactCleanupEngine.js`** — The daily cleanup cron.
- **New file `backend/routes/import_export_jobs.js`** — REST surface.
- **New file `frontend/src/pages/ImportExportJobs.jsx`** — Job-history admin page.
- **`multer`** — Already in dependencies; used for the file-upload multipart parsing.
- **`csv-parse` / `csv-stringify`** — Already in dependencies (used by `csv_io.js`); reused for handler input/output parsing.
- **`xlsx`** — Already in dependencies (used by `wellness.js` patient XLSX export); reused for XLSX input/output.

---

## §9 Open questions

- **OQ-9.1 File storage backend — local disk default OK, or S3 from day one?** Per DD-5.1 + FR-3.9 — local-disk by default + S3 plug. Confirm in product call: is there a known production tenant requiring S3 from v1 (e.g. compliance team wants S3 SSE-KMS encryption-at-rest)? **GATES IMPLEMENTATION START.**
- **OQ-9.2 Job-retention window — 30d default? Per-tenant configurable?** Per DD-5.6 + FR-3.10 — 30d default, per-tenant configurable up to 90d. Confirm threshold defaults. **GATES IMPLEMENTATION START.**
- **OQ-9.3 Cancellable in-flight jobs (operator clicks Cancel on RUNNING)?** Per DD-5.7 + FR-3.4.d — soft-cancel via per-batch status-check. Confirm cancel-latency UX is acceptable (5-10 seconds, not instant). **GATES IMPLEMENTATION START.**
- **OQ-9.4 Bulk-UPDATE flow (UPSERT IMPORT) — needed in v1 or v2?** Per DD-5.8 — CREATE-only for v1. Confirm no immediate operator demand for UPSERT.
- **OQ-9.5 PII exports (Patient list) require explicit "I acknowledge I'm exporting PHI" gate?** Per DD-5.5 — role-gate (b) + operator-attest (a) layered. Confirm both layers; confirm role list per resource type.
- **OQ-9.6 Email-on-completion default — opt-in or opt-out per user?** Per FR-3.6.b — opt-out by default (most operators want notifications). Confirm. Edge case: a USER who triggers many small imports may want to opt out to avoid email noise.
- **OQ-9.7 Error report — full original row included or just refs?** Per FR-3.8 — full original row included in the error CSV. Confirm. Trade: file-size grows linearly with failed-row count + original-row length; storage cost. For tenants with privacy concerns (the original row may carry PII), consider an `errorReportIncludesOriginalRow: Boolean @default(true)` flag.
- **OQ-9.8 Migration of existing endpoints — threshold-based (DD-5.3 (b)) or migrate-all?** Confirm phased migration approach per DD-5.3 + the per-resource-type threshold defaults. Migration is a multi-release effort; v1 ships the job system; v1.5 adds threshold-check to existing endpoints; v2 deprecates sync endpoints above-threshold.
- **OQ-9.9 Job-priority queue (URGENT jumps ahead of normal)?** Out of v1 per §7. Confirm no immediate operator demand.
- **OQ-9.10 Per-resource-type concurrency cap?** A tenant may have `maxConcurrentJobs=2` overall, but should PATIENT imports be capped to 1 (to avoid duplicate-key races within the same tenant)? Trade-off: stricter concurrency vs throughput. Confirm — likely fine as a single global per-tenant cap in v1, refined in v2 if races prove an issue.

---

## §10 Status snapshot

**Status:** NOT STARTED — PRD draft only; design call required to lock DD-5.1 / DD-5.2 / DD-5.3 / DD-5.5 / DD-5.6 + OQ-9.1 / OQ-9.2 / OQ-9.3 before any code lands.

**Owner:** TBD per product call. Likely allocation:
- Schema migration (additive: `ImportExportJob` + `Tenant` fields + `User.emailOnJobCompletionPreference`) — backend engineer ~0.5 day
- Engine (`importExportEngine.js` + `jobArtifactCleanupEngine.js`) — backend engineer ~1 day
- Handler registry + initial handler set (PATIENT + CONTACT + PRODUCT + SERVICE + VENDOR + LEAD + DEAL-export + INVOICE-export) — backend engineer ~2 days
- API routes (`import_export_jobs.js` — 8 endpoints) — backend engineer ~1 day
- Storage abstraction (`jobFileStorage.js`) + local-disk impl — backend engineer ~0.5 day
- Notifications + email integration — backend engineer ~0.25 day
- Audit + RBAC + PHI gating — backend engineer ~0.5 day
- Frontend admin page (`ImportExportJobs.jsx`) + new-job modal — frontend engineer ~1.5 days
- Per-module "Recent Imports/Exports" link surface — frontend engineer ~0.5 day
- Tests (api-spec for all 8 endpoints + vitest for registry + handler + engine + cleanup-cron + RBAC) — backend engineer ~1 day
- Wiring into `coverage.yml` + `deploy.yml` gate-spec lists — backend engineer ~0.25 day

**Total estimated effort post-design: 6-9 engineering days** across backend + frontend. (Slice 1 — schema + engine + 3 handlers + API + page; Slice 2 — remaining handlers + S3 storage + threshold-migration of existing endpoints.)

**Sibling PRDs in this cluster:**
- `PRD_PURCHASE_ORDERS.md` (tick #187 — Phase 2 consumer of PO-bulk-create via THIS PRD's job system)
- `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — sibling P2 operator-governance surface)
- `PRD_TRAVEL_SUPPLIER_MASTER.md` (consumer — existing supplier CSV bulk-import would migrate INTO this PRD's job system per DD-5.3)
- `PRD_TRAVEL_BILLING.md` (consumer — bulk-invoice export is a near-term operator demand)

**Blocks before backend impl can start:**
- DD-5.1 (single table vs fork) — MUST resolve
- DD-5.2 (queue-and-notify vs SSE) — MUST resolve
- DD-5.3 (migration strategy for existing endpoints) — MUST resolve
- DD-5.5 (PHI gate semantics) — MUST resolve
- DD-5.6 (metadata-indefinite + files-finite split) — MUST resolve
- OQ-9.1 (S3 vs local-disk for v1) — MUST resolve
- OQ-9.2 (retention defaults) — MUST resolve
- OQ-9.3 (cancel-latency UX) — MUST resolve

**Other DDs / OQs can iterate during implementation.**

**First implementation slice recommendation:**
- **Slice 1** (~3 days): Schema + engine + storage shim + PATIENT handler (since #820 is the immediate near-term consumer) + 8 API routes + admin page. Ships the core flow against PATIENT imports + exports. Pilots with the Enhanced Wellness tenant (Rishu's INR-flavored production tenant).
- **Slice 2** (~2 days): Remaining handlers (CONTACT, LEAD, PRODUCT, SERVICE, VENDOR, DEAL-export, INVOICE-export) + per-module entry-point surfaces.
- **Slice 3** (~1.5 days): Threshold-based migration of existing CSV/XLSX endpoints + retry-failed-rows flow + re-run flow + UI polish.
- **Slice 4** (~1 day): S3 storage adapter + cleanup cron + retention-extension UI + operator docs.

Slices are mostly sequential but slice 2 can parallelize across handlers if each is dispatched to a separate agent (the handlers are file-disjoint).

**Cluster placement in `MANUAL_CODING_BACKLOG.md`:** This work fits cluster D (the wellness operational session, since the most-pressing tenant for this is Rishu's Enhanced Wellness PATIENT migration). Proposal: add a new entry **D10. Import/Export Job History (#850)** under cluster D — sibling to D8 (Purchase Orders) and D9 (Payment Gateway Config) which are the same operational-governance shape from the same PRD-batch wave. Cross-references to B-cluster (travel) recommended because travel-supplier CSV import would migrate into this system per DD-5.3.

**Cross-PRD coordination check:** Before implementation starts, confirm:
- `PRD_PURCHASE_ORDERS.md` §7 ("Bulk PO operations from CSV") references THIS PRD as the implementation surface (rather than building its own bulk-import).
- `PRD_TRAVEL_SUPPLIER_MASTER.md` notes that the existing `travel_csv_io.js` flow will migrate into THIS PRD's job system in Slice 2.
- `PRD_TRAVEL_BILLING.md` bulk-invoice exports reference THIS PRD's INVOICE export handler.
- `routes/audit.js` `/verify` endpoint inherits IMPORT_EXPORT_JOB entries cleanly (no code change required).

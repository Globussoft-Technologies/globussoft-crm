an# TMC Platform – Master Plan → Codebase Tick-list (2026-06-16)

Cross-references the Google Doc **"TMC Platform – Master Plan"** (Phase Deliverables + Test
Scenarios checklists) against the **actual `globussoft-crm` working tree**, verified by a
read-only code sweep (file:line evidence per row).

**Important caveat — stack mismatch.** The plan proposes Next.js + NestJS + PostgreSQL + Redis.
This repo is **React/Vite + Express/Prisma/MySQL**. Ticks below judge whether the _functionality_
exists, not the named stack. The four "tenants" (TMC, RFU, Travelstall, Visa Sure) are implemented
as **sub-brands under one travel tenant** (`subBrandAccess[]`), not separate tenants — functionally
equivalent for everything in the plan.

**Legend:** ✅ done · 🟡 partial (core built, a sub-part missing/different) · ⬜ not built (absent,
or only for non-travel providers) · ⚙️ process/ops item (not code-verifiable).

---

## 2. Phase Deliverables Checklist — ✅ 27 · 🟡 8 · ⬜ 4 · ⚙️ 3 (of 42)

### Phase 0 — Foundations

- [x] ✅ **Repo & CI/CD** — `.github/workflows/deploy.yml` (6-gate pipeline)
- [x] ✅ **Three environments** — `deploy.yml` branches `main` + `staging_crm` (staging mirror + prod)
- [x] ✅ **Tenant theming** — `routes/sub_brand_themes.js`; `frontend/src/theme/travel.css`
- [x] ✅ **Data model + RLS** — `schema.prisma` tenantId on all tenant-owned models + `middleware/travelGuards.js` _(app-layer scoping, not DB row-level RLS)_
- [x] ✅ **Audit log** — `schema.prisma` `AuditLog` (hash-chained, tamper-evident) + `writeAudit`

### Phase 1 — Multi-tenant & Identity

- [x] ✅ **Tenant provisioning (4 tenants + Ops)** — `prisma/seed-travel.js` (4 sub-brands under travel tenant)
- [x] ✅ **Workspace SSO** — `routes/sso.js` (Google OAuth) + JIT provisioning
- [x] ✅ **Role-permission matrix** — `schema.prisma` `Role`/`RolePermission` + `verifyRole`
- [x] ✅ **Login Vault** — `routes/travel_suppliers.js` (AES-256-GCM creds, ADMIN-gated reveal + access log)

### Phase 2 — Sales Pipeline

- [x] ✅ **8-status pipeline** — `routes/pipelines.js` + `pipeline_stages.js` + transition guard in `deals.js`
- [x] ✅ **8 Lost Reasons** — `routes/win_loss.js` `WinLossReason` _(configurable; not pinned to exactly 8)_
- [ ] 🟡 **Manager View** — Kanban (`Pipeline.jsx`) + funnel (`routes/funnel.js`) + SLA-breach engine exist; **ageing-in-stage + lost-reason-mix dashboard not assembled**
- [x] ✅ **Assignment rule engine** — `routes/lead_routing.js` + `lib/leadAutoRouter.js`

### Phase 3 — Diagnostic & Lead Intake

- [x] ✅ **Diagnostic engine** — `lib/tmcDiagnosticEngine.js` + `lib/travelDiagnosticScoring.js`
- [x] ✅ **Editable question bank** — `routes/travel_diagnostics.js` (versioned banks per sub-brand)
- [x] ✅ **Curriculum mapping** — `CurriculumAdmin.jsx` + `TravelCurriculumMapping`
- [ ] 🟡 **Eligibility gate** — `lib/tmcLeadQuality.js` 5-rule classifier + ICP tiering; **ICP criteria feed scoring, not a hard binary admit/reject gate**
- [x] ✅ **PDF Recommendation Report** — `services/pdfRenderer.js renderTmcReadinessReport` (covers all 5 deliverables)
- [x] ✅ **48-hour SLA task** — `cron/leadSlaEngine.js` + `lib/leadSla.js computeFirstResponseDueAt`

### Phase 4 — Workspace Integrations

- [ ] 🟡 **Gmail integration** — inbound email via **Mailgun webhook** (`routes/email_inbound.js`); **no IMAP/Gmail-sync layer**
- [x] ✅ **Calendar integration** — `routes/calendar_google.js` + `calendar_outlook.js` + `lib/calendarSlots.js`
- [ ] ⬜ **Drive integration** — no Google Drive / per-record folder code found

### Phase 5 — Wati + WhatsApp

- [ ] 🟡 **3 Wati workspaces connected** — `services/watiClient.js` (travel transport) with per-sub-brand channel via `lib/subBrandConfig.js`; **config-level routing, not 3 distinct connected workspaces**
- [x] ✅ **Meta templates** — `WhatsAppTemplate` + `submitTemplateToMeta` + `cron/whatsappTemplateSyncEngine.js` _(capability built; actual submissions are an ops step)_
- [x] ✅ **Embedded WhatsApp Web** — `WhatsAppChat.jsx` + `routes/whatsapp.js` threads
- [x] ✅ **Inbound mapping** — `routes/whatsapp_webhook.js` upserts `WhatsAppThread` → contact

### Phase 6 — Ad-Platform APIs

- [ ] ⬜ **Meta Lead Ads ingest** — `marketplace_leads.js` covers IndiaMART/JustDial/TradeIndia only; no Meta Lead Ads
- [ ] ⬜ **Google Ads offline conversion** — no refs found
- [ ] ⬜ **Spend/impression sync** — no ad-spend/impression sync (only LLM-spend observability)

### Phase 7 — Trip / Ops / Accounting

- [ ] 🟡 **Trip auto-creation** — trip records + management exist (`routes/travel_trips.js`); **quote/itinerary accept does NOT auto-create a trip (`travel_quotes.js` only transitions status)**
- [x] ✅ **Trip microsite** — `routes/travel_microsites.js` + `PublicTripMicrosite.jsx` (+ OTP)
- [x] ✅ **Parent portal** — `routes/portal.js` + `TravelCustomerPortal.jsx` (register, add traveller, upload, pay)
- [ ] 🟡 **Passport OCR + verification** — upload + manual-verification queue shipped (`PassportVerificationQueue.jsx`, `routes/travel_passport.js`); **automated OCR extraction is cred-blocked / stubbed**
- [ ] 🟡 **Payment plan + rooming + departure checklist** — payment plan ✅ (`travel_trip_billing.js`), rooming ✅ (+ XLSX export); **departure = a readiness _score_, no checklist document**
- [x] ✅ **GST + CA export** — `routes/travel_invoice_ledgers.js` (customer ledger, TDS register, commission ledger; CSV/Tally shape)

### Phase 8 — Delivery Package

- [x] ✅ **Brand assets per tenant** — `routes/brand_kits.js` `BrandKit` (logo/palette/templates per sub-brand) _(actual Yasin brand pack still pending — Q22)_
- [x] ✅ **KPI definitions catalog** — `lib/widgetCatalog.js` / `lib/pageCatalog.js`
- [x] ✅ **Reminder schedules** — `cron/travelMilestoneRemindersEngine.js` (T-7/T-3/T-1/T+0)
- [ ] 🟡 **Report scaffolding** — `routes/travel_reports.js` + `cron/reportEngine.js` (scheduled PDF/CSV); **named digests (daily ops / weekly sales / monthly KPI / per-trip closeout) not all built**

### Phase 9 — Hardening, UAT, Launch

- [ ] ⚙️ **UAT pass** — process (large automated test suite exists; formal UAT not code-verifiable)
- [ ] ⚙️ **Security review** — process (`security-review` skill + gitleaks `secret-scan.yml` exist)
- [ ] ⚙️ **Go-live + 30-day hypercare** — process (demo is deployed at crm.globusdemos.com)

---

## 3. Test Scenarios Checklist — ✅ 9 · 🟡 10 · ⬜ 6 (of 25)

- [ ] 🟡 **Landing pages render all required sections** — landing-page system exists (`landing_pages.js`); per-Architecture-PDF section parity unverified
- [ ] ⬜ **FAQ schema validates (Rich Results)** — no JSON-LD / schema.org markup found
- [ ] ⬜ **No pricing exposed pre-diagnostic** — no pricing-visibility gating found on public surfaces
- [ ] 🟡 **Diagnostic form fields match exactly (8 fields)** — diagnostic + public TMC form exist (`TmcReadiness.jsx`, 12-Q); exact 8-field intake parity not verified
- [x] ✅ **48-hour SLA task auto-created** — `cron/leadSlaEngine.js`
- [ ] 🟡 **Eligibility gate flags non-ICP** — classifier scores, not a hard flag (see Phase 3)
- [x] ✅ **PDF Recommendation Report has 5 deliverables** — `pdfRenderer.js`
- [ ] 🟡 **Qualified→Discovery Call; disqualified→nurture** — qualified→booking link ✅ (`travel_diagnostics.js`); **disqualified→nurture flow not found**
- [ ] ⬜ **Calendar booking respects timezones** — no timezone-conversion code in `calendarSlots.js`
- [x] ✅ **Quotation v2 supersedes v1 (audit visible)** — `TravelQuoteSnapshot` version history
- [ ] 🟡 **Trip auto-creation on confirmation** — no auto-trigger (see Phase 7)
- [ ] 🟡 **Parent invite via OTP + magic link (email & WhatsApp)** — email-OTP ✅ + WhatsApp OTP (Wati) ✅; **magic-link URL not implemented**
- [ ] 🟡 **Passport OCR partial-fills; manual verification corrects** — manual verification ✅; **OCR auto-fill cred-blocked**
- [ ] ⬜ **Room conflict blocked at allocation** — rooming CRUD exists; no conflict/duplicate-allocation guard
- [x] ✅ **GST invoice CGST/SGST/IGST split by state** — `travel_invoice_ledgers.js`
- [ ] 🟡 **CA export totals match analytics revenue** — CA export ✅ + revenue-by-destination analytics ✅; reconciliation is a test to run
- [x] ✅ **Repeat-school metric increments** — `travel_reports.js` `repeatSchools` / `repeatRatePct`
- [ ] 🟡 **Manager View shows ageing + SLA breaches** — SLA-breach engine ✅; ageing-in-stage view partial
- [x] ✅ **8 Lost Reasons enforced on close** — `win_loss.js` (configurable count)
- [x] ✅ **Rule-based assignment routes leads** — `lead_routing.js` + `leadAutoRouter.js`
- [x] ✅ **Login Vault reveal requires step-up MFA + audit** — `routes/auth_stepup.js` + supplier-credential access log
- [ ] ⬜ **Impersonation banner, time-boxed, audit-logged** — no staff impersonation feature found
- [ ] 🟡 **Tenant switcher re-issues scoped session + re-themes** — per-sub-brand theming + `ActiveSubBrand` ✅; **full tenant-switch session re-issue is single-tenant-per-session (log out to switch)**
- [x] ✅ **Customer cannot access another's resource by URL** — `routes/portal.js` (all reads scoped by `contactId`+`tenantId`)
- [ ] ⬜ **Owner Group view aggregates KPIs across 4 tenants** — OWNER cross-tenant _access_ exists; no aggregated KPI dashboard

---

## 4. Headline

**Built & working (✅):** identity/SSO/RBAC/vault/MFA, multi-tenant + audit, pipeline + lost
reasons + assignment, diagnostic engine + question bank + curriculum + 5-deliverable PDF + 48h SLA,
calendar, WhatsApp (templates/embed/inbound mapping), microsite, customer portal + resource-scoped
IDOR guard, GST + CA export, brand-kit system, KPI catalog, reminders, quotation versioning,
repeat-school metric.

**Genuinely NOT built in this codebase (⬜):**

1. **Ad platforms** — Meta Lead Ads, Google Ads offline conversion, spend/impression sync (Phase 6 entirely)
2. **Google Drive** per-record folders
3. **Staff impersonation** (banner / time-box / audit)
4. **Owner Group cross-tenant KPI dashboard**
5. **FAQ JSON-LD schema** + **pre-diagnostic pricing gate** + **calendar timezone handling** (website/booking polish)
6. **Room-conflict guard** at allocation

**⚠️ Security flag (already tracked, jumps the queue):** **uploaded visa/passport documents are stored
UNENCRYPTED** — `lib/visaDocStore.js` writes plaintext to S3/disk and never calls
`lib/fieldEncryption.js` (which exists). Matches Gap A1 in
[VISA_SURE_PHASE_3_GAP_ANALYSIS_2026-06-16.md](VISA_SURE_PHASE_3_GAP_ANALYSIS_2026-06-16.md).

**Biggest "almost done" (🟡) worth a short push:** Manager-View ageing/lost-mix dashboard;
trip auto-creation trigger on quote acceptance; magic-link customer auth; departure-checklist doc;
named report digests.

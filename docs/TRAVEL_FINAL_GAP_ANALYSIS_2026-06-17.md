# Travel CRM — Final Gap Analysis (2026-06-17)

**Method:** code-verified audit. Six parallel sweeps cross-referenced the travel PRDs
against the actual `backend/` + `frontend/` code (routes, crons, libs, schema, pages),
then key claims were spot-checked against source. Status reflects what is **in the code
on `feat/pincancle`**, not what the prior gap docs assert.

**Supersedes** the dated series `TRAVEL_PRD_GAP_ANALYSIS_2026-06-12/-15/-16.md` and folds
in `TRAVEL_GAP_CLOSURE_TRACKER.md` (the prior master, 2026-06-13). Where this doc and the
trackers disagree, **this doc wins** (it is code-verified and later).

> ⚠️ Percentages are approximate completion judgements from the audit, not test coverage.
> Two false gaps from the raw sweep were corrected here (payment-schedule cron *is*
> registered; `FlightQuoteAgent` page *does* exist).

---

## 0. TL;DR — what to fix first

1. 🟠 **Visa document handling — CORRECTED 2026-06-17.** Earlier framed as "encrypt the
   files (AES-256-GCM)"; that was **wrong** — app-encrypting S3 objects would break the
   admin/customer view path, and S3 already encrypts at rest (SSE, default-on, transparent
   to viewing). The *real* questions are (a) **at-rest**: make S3 SSE explicit
   (`ServerSideEncryption:'AES256'` in `s3Service.uploadFile` PutObject — 1-line, no view
   impact) — optional since AWS defaults it; (b) **access control**: `uploadFile` returns a
   bare `${S3_BASE_URL}/${key}` and **no signed-URL is used on read** — so if the prod
   bucket is *public*, a passport link is forever-public. Fix = confirm bucket is private
   (ops) + serve reads via `s3Service.getSignedUrl` (already exists, unused). Disk fallback
   is auth-gated (not in `openPaths`). Not "encryption" work. ~0.5d if signed reads wanted.
2. 🟠 **Visa data retention** — `VisaApplication`/`VisaDocumentChecklistItem` are **absent
   from `cron/retentionEngine.js`** (no 84-month history / 24-month doc retention). Separate
   from the above; additive (retention only fires under an explicit `RetentionPolicy` row). ~0.5d.
2. 🔴 **CRITICAL / security:** Sequential enumerable IDs on every public model → IDOR. No
   opaque `publicId`. ~5–7d (Wave 5). Mitigated today only by tenant-scope guards.
3. ✅ **Email-OTP route-layer gate — IN PLACE (opt-in) 2026-06-17.** Was UI-gated only. All 4
   self-serve registration endpoints now call `emailOtp.enforceRegistrationOtp`, which
   **requires** a verified-email token when enforcement is on. **Opt-in only
   (`REQUIRE_EMAIL_OTP=1`), default OFF everywhere.** **Team invitation is exempt** (product
   call 2026-06-17): an authenticated admin (Settings → invite) skips the gate via
   `isAuthenticatedCaller` — only **anonymous public signup** is OTP-gated. One residual before
   flipping the flag: **GetStarted.jsx** is a 2nd anonymous signup page with no OTP step, so it
   would 403 under enforcement — give it the OTP field (like Signup.jsx) first, or retire it.
   (Separately, Settings team-invite hitting `/auth/register` spins up a *new tenant* per invite
   — a pre-existing bug, left as-is per "let them manage this".) Until the flag is set the gate
   is a no-op (identical to prior behaviour).
4. 🟠 **Engineering-actionable punch list** (no external blocker) — see §3. ~10–15d total.
5. 🟡 **Cred-blocked** (~85 items) collapses fast: **Q22 brand pack (~45), Q9 Wati (~15),
   Q11 LLM keys (~10)** are the three mega-unblockers — see §4.

---

## 1. Status by area

| Area | Status | Headline |
|---|---|---|
| **TMC diagnostic & sales engine** | ✅ ~89% | Engine, lead-quality, guardrail, curriculum, catalogue, report PDF all shipped. Gaps are content (curriculum rows) + Google-Meet booking + a few product calls. |
| **RFU (Umrah) ground services** | 🔴 ~10% | Profiles + religious packets + journey-reminder cron shipped. The 3 core integrations (Zikr Cabs, 5-portal hotel scraper, Haramain HSR) are **stub-only**; models not built. Cred + decision blocked. |
| **Visa Sure (Phase 3)** | 🟡 ~69% | Diagnostic, risk-flag cron (13 rules), advisor dashboard, checklist, analytics, recovery shipped. **CRITICAL doc-encryption gap.** Branded PDF/delivery, rejection-history seeding, AI summary partial. |
| **Itineraries / Quotes / Pricing** | ✅ ~75% | Templates, day-editor+map, LLM suggest, quote builder, FX-lock, quote→invoice, pricing engine shipped. POI dedup + approval queue + RBI FX cron are gaps. |
| **Billing / GST / Suppliers** | 🟡 ~60% | Invoices, GST split, GSTR-1/3B/HSN/27EQ, suppliers, payables, commissions, reconciliation, settlement shipped. Tax-rate master, customer/TDS ledgers, RCM, KYC hard-block, auto-PO are gaps. |
| **Leads / Multichannel** | 🟡 ~50% | Unified 16-channel intake + dedup + touchpoints + idempotency shipped. Routing-rule channel/subBrand wiring, `/settings/lead-capture` UI, inbox grouping are gaps. |
| **Marketing / Flyers** | 🟡 ~35% | Template CRUD + studio shell shipped. Canvas editor, asset library, AI copy/image, WA share, distribution are gaps (DD-5.1 + creds). |
| **Pipeline Kanban** | ✅ ~95% | Board, drag-drop, sub-brand filter, a11y, touch, virtualization shipped. Effectively done. |
| **Per-sub-brand branding** | 🟡 ~10% | `BrandKit` model + `subBrandConfig.js` resolver shipped. ~9 consumer surfaces (PDF/email/portal/embed/microsite) + admin UI + upload **not wired**. Q22-blocked. |
| **B2B agent portal** | ⛔ 0% | Entire 34-FR substrate absent by design (7 design decisions gated; now marked resolved — see §5). |
| **Customer portal & comms** | 🟡 ~50% | Login, itineraries, KYC stub, review surface, web-checkin Yes/No, pay-or-cancel shipped. Sub-brand theming + multi-traveler + analytics are gaps. |
| **Lifecycle / notification engines** | ✅ ~67% | trip-countdown, payment-deadline, web-checkin email, review, journey/milestone reminders shipped (this session). Gaps: in-app Notification fan-out, SMS/WhatsApp legs, observability. |
| **Security architecture** | 🔴 ~32% | Field-encryption helper, credential vault, audit log, RBAC, cross-tenant interceptor shipped. 23 FRs gap incl. the 2 CRITICAL items in §0. |

---

## 2. Critical security callouts (verified)

| # | Finding | Evidence | Fix |
|---|---|---|---|
| S1 | **Visa doc access-at-rest** — NOT an app-encryption gap (corrected). S3 SSE covers at-rest; app-encryption would break viewing. | `s3Service.uploadFile` returns bare `${S3_BASE_URL}/${key}`; `getSignedUrl` exists but unused on read | (a) explicit `ServerSideEncryption:'AES256'` 1-liner; (b) if bucket public → signed-URL reads. Confirm bucket privacy (ops). |
| S2 | **No retention policy for visa data** | `cron/retentionEngine.js` has zero `VisaApplication`/`VisaDocument` entries | Add entity-map rows (84-mo history / 24-mo docs). ~0.5d |
| S3 | **IDOR via sequential IDs** | every Prisma model uses `Int @id @default(autoincrement())`; no `publicId` | Opaque-ID migration (Security FR-3.3). ~5–7d, Wave 5 |
| S4 | ✅ **Email-OTP gate IN PLACE (opt-in) 2026-06-17** | `enforceRegistrationOtp` gates the 4 register endpoints; default OFF; team-invite (auth'd admin) exempt via `isAuthenticatedCaller` | `REQUIRE_EMAIL_OTP=1` to enforce. Only residual: add OTP to GetStarted.jsx (anonymous signup, no OTP) before flipping, else it 403s. |
| S5 | **JWT in localStorage / no logout denylist** | `middleware/auth.js` reads Bearer; no `jti` revocation | Cookie migration + denylist (FR-3.1). ~3–5d, Wave 5 |

Shipped security evidence (compliance-ready): `lib/fieldEncryption.js` (AES-256-GCM), `SupplierCredential` vault + access log, `AuditLog`+`writeAudit`, `middleware/crossTenantInterceptor.js`, ESLint tenant-scope rule, `User.subBrandAccess` RBAC.

---

## 3. Engineering-actionable now (NO external blocker) — the punch list

These need no creds and no decisions — pure build. Ordered by value.

| # | Item | Area | Evidence / note | Est |
|---|---|---|---|---|
| A1 | Encrypt visa document storage + add visa retention rows | Visa/Security | `lib/visaDocStore.js`, `cron/retentionEngine.js` | 1d |
| A2 | Enforce email-OTP `verificationToken` at the route layer | Auth | `routes/auth.js`, `routes/portal.js` | 0.5d |
| A3 | Populate `rejectionHistoryJson` at diagnostic submit (so risk rule R3 can fire) | Visa | `routes/travel_diagnostics.js` never writes it | 0.5d |
| A4 | Add Visa Sure **Reports** sidebar link (route exists, link missing) | Visa | `Sidebar.jsx:1597-1607` | 5min |
| A5 | Wire POI dedup (`lib/poiDedup.js`) into the sightseeing POST + add pending-approval queue/route/page | Itinerary | helper exists, not wired into `travel_sightseeing.js` | 2d |
| A6 | GST **TaxRateMaster** model + admin CRUD (rates hard-coded today; DD-5.2 already decided "operator UI") | Billing | `lib/gstCalculation.js` hard-coded + TODO | 1–2d |
| A7 | GST tax-reporting endpoints: customer ledger, TDS register, commission ledger | Billing | not shipped (GSTR-1/3B/HSN/27EQ are) | 3d |
| A8 | Invoice FY-rollover numbering (currently resets on Jan-1, should be Apr-1) | Billing | `travel_invoices.js` serial reset | 0.5d |
| A9 | Auto-PO on booking-confirm + credit-limit hard-block gate | Billing/Supplier | cross-PRD hook missing | 1d |
| A10 | Supplier KYC route handlers + transaction hard-block (models exist) | Supplier | `TravelSupplierKyc*` models unwired (G038) | 1d |
| A11 | `/settings/lead-capture` operator UI + channel badge/filter on `/leads` | Leads | backend shipped, UI missing | 1.5d |
| A12 | Lead-routing rules: wire `channel` + `subBrand` into match logic + form-ID→sub-brand map | Leads | `LeadRoutingRule` fires on generic patterns only | 1.5d |
| A13 | Quote counter-offer `Counter` status + data model (UI pages exist) | Quotes | captured in audit only | 1d |
| A14 | Lifecycle engines: in-app `Notification` fan-out + SMS fallback when no email | Engines | engines email-only today | 1.5d |
| A15 | Advisor **"Expire (unpaid)"** button on itinerary detail (pay-or-cancel flow completion) | Itinerary | status value + flag shipped; one-click UI missing | 0.5d |
| A16 | Default brand-kit seeding (`seed-travel.js`) + brand-kit version-purge cron | Branding | DD-5.3/5.6 | 1d |

**Subtotal ≈ 18–19 eng-days** of unblocked work.

---

## 4. Credential-blocked (by blast radius)

All `PENDING` unless noted. Most have stub clients already in place → swap is fast once creds land.

| Q-marker | Owner | Unblocks | Swap |
|---|---|---|---|
| **Q22 — brand pack** (logos/palettes/fonts/PDF covers ×4 sub-brands) | Yasin | **~45 FRs** across Branding (33) + Visa variants + Flyers + per-brand invoice/quote PDFs | 2–3d (surfaces pre-wired) |
| **Q9 — Wati WhatsApp** (WABAs + Meta token) | Yasin | **~15 consumers**: journey/web-checkin/payment/review/milestone crons, quote send, visa alerts, flyer WA share, OTP, boarding pass | 1–2d (client written) |
| **Q11 — LLM keys** (Gemini + Anthropic) | Yasin | All AI surfaces: talking-points, form-vs-call, **visa-summary**, flyer copy, itinerary-suggest, marketing image, the 3 lifecycle-engine copy tasks | 1d |
| **Q3 — DigiLocker** | Travel Stall | Real Aadhaar KYC (TMC parent reg + portal); pairs with Q2 counsel | 1d |
| **Q19 — RateHawk** | Travel Stall | RFU lowest-rate hotel auto-pick (stub exists) | 1d |
| **Q-GST-2/3/4** — GSTIN reverse-check API, per-sub-brand GSTINs, LUT refs | Travel Stall | GST reverse-check + sub-brand resolution + zero-rated export | 0.5–1d each |
| **Q-BILL-1** — TCS non-filer source | Travel Stall | 20% non-filer TCS path | 1d |
| **Q1** — Callified / AdsGPT / Google Workspace | Travel Stall / Yasin | AI calling, marketing reports, Drive folder auto-create | 1d each |
| **Q-MF-1/2** — asset storage (S3/Cloudinary) + AI image-gen | Yasin | Flyer asset library + live image gen | 1–2d |
| **Q-RFU-1..7** — Zikr Cabs, 5 Saudi hotel portals, Haramain HSR | Travel Stall / Yasin | All RFU ground-services. **5-portal scraper has NO code**; Zikr/HSR are stubs + need new models | 8–10d build (hotels) + ~5d (cab/rail) |
| **Q8** — Excel Software accounting bridge | Yasin | Accounting export. **No stub** — needs vendor docs first | 3–5d post-docs |
| **Q2** — Aadhaar consent legal sign-off | Travel Stall counsel | Real Aadhaar capture (`docs/TRAVEL_AADHAAR_CONSENT_DRAFT.md` ready) | 15min swap |
| **Q21 / Q6** — DNS+wildcard SSL, on-prem hosting | Travel Stall ops | TMC microsite subdomains; Phase-1 deploy target | ops |
| **PC-1** — Passport OCR vendor (DocAI/Azure) | Travel Stall/GS | Parent-reg OCR (on-box tesseract interim) | 1–2d swap |

**Order of ROI:** Q22 → Q9 → Q11 → (Q3 + Q2 counsel) → Q19 → Q-GST subset.

---

## 5. Decision status

`DECISIONS_TRACKER.md` (2026-05-25) marks **all 218 design decisions resolved** (incl. the 7 B2B portal calls, GST tax-rate-UI, security cookie/ID/rollout). **Caveat from this audit:** several per-PRD `DD-*`/`OQ-*`/`PC-*` markers are still written as "open" inside the individual PRD files and aren't reflected in code yet. So:

- **For planning:** treat decisions as resolved — engineering has a green light.
- **Before building a specific feature:** confirm the resolution is captured (DECISIONS_TRACKER) and hasn't drifted from the PRD's stale "open" text.
- **Genuinely still open (per audit):** Visa Sure PC-cluster residuals (PC-2 recovery reuse-vs-retake; PC-3 per-embassy rejection-rate catalogue ownership; family-trigger source — `VisaApplication.familySize` exists but unused); airline web-checkin **P1B** "decision to *start*" (DC-1..5) — not a blocker, manual-agent fallback works.

---

## 6. Notable "false gaps" corrected vs. the raw sweep

- `cron/paymentScheduleReminderEngine.js` **IS** registered (`server.js:1540-1541`) and `tripPaymentReminders` at `:1533` — not an unregistered cron.
- `FlightQuoteAgent.jsx` **exists** and is routed (was reported missing in a 06-15 doc).
- Pipeline Kanban FR-3.16/17/18 (touch, a11y, virtualization) **are** shipped (`Pipeline.jsx`).

---

## 7. Doc inventory (what to keep / archive)

| Doc | State | Action |
|---|---|---|
| **TRAVEL_FINAL_GAP_ANALYSIS_2026-06-17.md** (this) | CURRENT | Single source of truth going forward |
| TRAVEL_GAP_CLOSURE_TRACKER.md (06-13) | superseded by this for status; keep its wave plan | Reference for execution waves |
| TRAVEL_PRD_GAP_ANALYSIS_2026-06-16 / -15 / -12 | superseded | Archive under `docs/gaps/archive/` |
| DECISIONS_TRACKER.md (05-25) | current | Keep — decision system of record (see §5 caveat) |
| CREDS_NEEDED_FROM_YASIN.md (06-14) | current | Keep — Yasin action list |
| CREDS_TRACKER.md (05-23) | stale | Refresh from §4 here or archive |
| PRD_TRAVEL_SECURITY_ARCHITECTURE.md | active draft | Keep — drives Wave 5 |
| Per-feature PRDs (15) | active | Keep — but reconcile stale DD/OQ "open" text (§5) |

---

## 8. Suggested sequencing

- **Wave A (now, ~3d):** S1+S2 visa encryption/retention, A2 OTP enforcement, A3 rejection-history, A4 reports link, A15 expire button. (Security + quick wins, zero blockers.)
- **Wave B (~6d):** A5 POI dedup/approval, A6 tax-rate master, A7 tax ledgers, A8 FY numbering, A9/A10 PO+KYC.
- **Wave C (~5d):** A11/A12 lead-capture UI + routing, A13 counter-offer, A14 notification fan-out, A16 brand seed.
- **Wave 5 security (~18d):** opaque IDs, cookie auth + denylist, tenant-scope audit, CSP enforce, list-PII projection.
- **Cred-gated (parallel, on drops):** Q22 → branding/flyers/PDFs; Q9 → all WhatsApp legs; Q11 → AI surfaces; Q-RFU-* → RFU ground services (largest remaining build).
- **Decision-to-start:** B2B agent portal (~25–45d once kicked off), airline web-checkin P1B.

---

*Generated from a 6-way parallel code audit on 2026-06-17 (branch `feat/pincancle`). Spot-check
any line-referenced claim before acting; percentages are directional, not test coverage.*

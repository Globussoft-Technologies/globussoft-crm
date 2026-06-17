# Visa Sure (Phase 3) — Gap Analysis vs. Codebase — 2026-06-16

**Scope:** [PRD_VISA_SURE_PHASE_3.md](PRD_VISA_SURE_PHASE_3.md) FR-1…FR-8 + NFRs, **plus** the
customer-facing + auth work shipped this cycle (self-serve portal, unified
login, email-OTP registration). Verified against the **current working tree**
(not assumptions) via a 5-cluster code sweep; every line below cites real
`file:line` evidence or marks `NOT FOUND`.

**Method:** parallel read-only verification of (1) diagnostic+PDF, (2) risk
engine+embassy rules, (3) advisor dashboard+LLM, (4) quotation+documents,
(5) analytics+nav+portal+auth+retention. Synthesised here.

---

## 1. Executive summary

Visa Sure Phase 3 is **largely shipped** — the advisor surface, document
checklist lifecycle, quotation-template admin, analytics, recovery program,
customer self-serve portal, and email-OTP registration all work end-to-end.
The remaining gaps cluster into four buckets:

| Bucket | Count | Headline items |
|---|---|---|
| **A — Engineering-actionable now** (no external blocker) | 9 | **FR-6.4 documents stored UNENCRYPTED** (security); FR-5.2 quote-template *consumer*; rejection-history not populated at diagnostic submit; `familySize` not consumed by risk engine; visa retention rows missing; Reports sidebar link missing; diagnostic-report **email** delivery; email-OTP API-bypass |
| **B — Decision-blocked** (product call) | 5 | High-rejection-rate destination (PC-3); EmbassyRule consumption breadth (PC-1..PC-5/PC-7); recovery diagnostic reuse (PC-2); cool-down gate (PC-4) |
| **C — Cred-blocked** | 3 | `visa-summary` LLM (Q11); WhatsApp advisor alerts + diagnostic WA delivery (Q9); passport OCR (C-cluster) |
| **D — Brand-asset-blocked** (Yasin Q22) | 3 | Visa-Sure PDF brand template + tone (FR-1.3/2); `visa-sure.css` theme; visa quote-PDF branding (FR-5.3) |

**The one item that should jump the queue:** **FR-6.4 — uploaded visa
documents (passport scans, bank statements) are stored in plaintext** (S3/disk,
unguessable filename only). The PRD NFR explicitly requires AES-256-GCM at rest
via `lib/fieldEncryption.js`. This is a real compliance/security gap, not a
deferral.

---

## 2. FR-by-FR status

| FR | Requirement | Status | Evidence |
|---|---|---|---|
| **FR-1.1** | 15-Q visa diagnostic + weighted-sum + 4 readiness levels | ✅ SHIPPED | `prisma/seed-travel.js:352-523`; `lib/travelDiagnosticScoring.js:35-113` |
| **FR-1.2** | Editable scoring via admin endpoint | ✅ SHIPPED | `routes/travel_diagnostics.js:172-236` (versioned banks) |
| **FR-1.3 / FR-2** | Visa-Sure-**branded** PDF report | 🟡 PARTIAL | `services/pdfRenderer.js:3071-3234` — generic template, only label + accent colour; no visa tone/copy, no `visa-sure.pdfkit.js` |
| **FR-1.3 / FR-2** | Report **emailed** / WA-delivered | ❌ MISSING | `routes/travel_diagnostics.js:403-513` — PDF generated, never dispatched |
| **FR-3.1(a)** | Complex = applicationType ∈ {work,student,business,hajj} | ✅ SHIPPED | `cron/visaRiskFlagEngine.js:149-153` |
| **FR-3.1(b)** | Complex = priorRejectionCount ≥ 1 | ❌ MISSING | No `priorRejectionCount` column (only `priorApplicationId` FK, `schema.prisma:~6149`); trigger not implemented |
| **FR-3.1(c)** | Complex = family/dependents | 🟡 PARTIAL | `VisaApplication.familySize` exists (`schema.prisma:6140`) but the engine never reads it — PC-8 "resolved" yet uncoded |
| **FR-3.1(d)** | Complex = high-rejection-rate destination | 🟡 PARTIAL | `visaRiskFlagEngine.js:271-277` — "new destination" **proxy** only; real rejection-rate lookup deferred (PC-3) |
| **FR-3.2** | Rejection-history tagging | 🟡 PARTIAL | Engine reads `rejectionHistoryJson` (`visaRiskFlagEngine.js:168-180`) but it is **never populated at diagnostic submit** (`routes/travel_diagnostics.js` has zero refs); no diagnostic→application mirror |
| **FR-3.3** | Advisor priority alerts | 🟡 PARTIAL | `Notification` created (`visaRiskFlagEngine.js:492-502`); WhatsApp/email dispatch deferred (Q9) |
| **FR-4 list** | Applications list + filters | ✅ SHIPPED | `pages/travel/visa/Applications.jsx`; `routes/travel_visa.js:343-465`; `?status=` deep-link `Applications.jsx:206-210` |
| **FR-4 detail** | Diagnostic Q/A + risk chips + checklist + status + history + recovery | ✅ SHIPPED | `AdvisorDashboard.jsx` (diagnostic 466-527, risk 546-605, checklist 792-1019, status 432-463, recovery 607-787); `routes/travel_visa.js:1507-1618` |
| **FR-4 AI summary** | `visa-summary` LLM consumer | ❌ MISSING | Static placeholder `AdvisorDashboard.jsx:532-541`; no `visa-summary` in `lib/llmRouter.js`; no `aiSummary` field — Q11-blocked |
| **FR-4 checklist admin** | Checklist template CRUD | ✅ SHIPPED | `Checklists.jsx`; `routes/travel_visa.js:2769-2932` |
| **FR-5.1** | Manual quotation (visa surface) | 🟡 PARTIAL | Generic `QuoteBuilder.jsx:115-120` (`visasure` is a subBrand option); no visa-specific surface |
| **FR-5.2 admin** | Quotation template CRUD | ✅ SHIPPED | `VisaQuotationTemplate` `schema.prisma:6240-6254`; `routes/travel_visa.js:3151-3320`; Checklists tab |
| **FR-5.2 consumer** | Pick template → auto-populate quote → persist Itinerary | ❌ MISSING | No endpoint/UI to apply a template to a quote |
| **FR-5.3** | Branded visa quote PDF | 🟡 PARTIAL | Generic `TravelQuote` PDF reused; no `visa-quote.pdfkit.js`; branding unverified |
| **FR-5.4** | Stored as `Itinerary.subBrand="visa-sure"` | ✅ SHIPPED | `Itinerary.subBrand` `schema.prisma:~5447` |
| **FR-6.1** | Checklist templates per type×destination | ✅ SHIPPED | `VisaChecklistTemplate`; `routes/travel_visa.js:2767-2937` |
| **FR-6.2** | Per-application document upload + seed-on-create | ✅ SHIPPED | Portal upload `routes/portal.js:1341-1412` via `lib/visaDocStore.js`; seed `routes/travel_visa.js:165-187,1761-1777` |
| **FR-6.3** | Status tracking pending→uploaded→verified/rejected | ✅ SHIPPED | `schema.prisma:6195`; PATCH `routes/travel_visa.js:3052-3150` |
| **FR-6.4** | **Encryption at rest (AES-256-GCM)** | ❌ **MISSING** | `lib/visaDocStore.js:33-43` writes **plaintext** to S3/disk; `fieldEncryption.js` not used (UUID filename only) |
| **FR-6.5** | Auto-advance docs-pending → filed | ✅ SHIPPED | `routes/travel_visa.js:234-302` (`maybeAdvanceOnChecklist`) |
| **FR-7** | Analytics: recovery-rate, conversion-by-readiness, lead-source-rate | ✅ SHIPPED (+bonus) | `routes/travel_visa_analytics.js:106-943` (3 spec'd + by-month/quarter/year); `Reports.jsx` |
| **FR-7** | Secondary: time-to-file/decision, tier-mix, advisor-productivity | ❌ MISSING | Not implemented |
| **FR-8 nav** | Visa Sure sidebar group | 🟡 PARTIAL | 4/5 links `Sidebar.jsx:1596-1601` — **Reports link missing** (route exists `App.jsx:1587`) |
| **FR-8 landing** | `/travel/visa` lands on dashboard | ✅ SHIPPED | `App.jsx:1578` |
| **FR-8 theme** | `visa-sure.css` brand palette | 🟡 PARTIAL | No dedicated file; uses generic `theme/travel.css` (pending Yasin Q22) |

### This-cycle additions (beyond the original PRD FR list)

| Feature | Status | Evidence |
|---|---|---|
| Rejection-recovery program (model + admin + enrol) | ✅ SHIPPED | `RejectionRecoveryProgram` `schema.prisma:6165-6187`; `RecoveryProgram.jsx`; enrol route `routes/travel_visa.js` |
| EmbassyRule model + CRUD + admin | ✅ SHIPPED | `routes/embassy_rules.js`; `EmbassyRulesAdmin.jsx`; `schema.prisma:6275-6294` |
| EmbassyRule **consumption** | 🟡 PARTIAL | Only R13 cooldown reads it (`visaRiskFlagEngine.js:353-363`); checklist engine has zero refs — PC-1..PC-5/PC-7 |
| Customer self-serve portal — "My Visa" (preview, start, upload, cancel, **multiple** apps) | ✅ SHIPPED | `TravelCustomerPortal.jsx` (`VisaApplicationCard`); `routes/portal.js` GET/POST/DELETE `/travel/visa/applications`, `/checklist-preview`, `/documents/:itemId/upload` |
| Unified login (staff `/login` falls back to portal auth) | ✅ SHIPPED | `Login.jsx` `performLogin`→`tryPortalLogin`; standalone portal login retired (`TravelCustomerPortal.jsx` redirects unauth→`/login`) |
| Email-OTP registration (org signup + customer) | ✅ SHIPPED | `lib/emailOtp.js`; `routes/auth.js` `/email-otp/{request,verify}`; `EmailOtpField.jsx`; `emailVerifiedAt` on Tenant/User/Contact |

---

## 3. Gaps by blocker

### A — Engineering-actionable now (no external dependency)

| # | Gap | Evidence | Effort | Recommendation |
|---|---|---|---|---|
| A1 | **FR-6.4: documents stored unencrypted** | `lib/visaDocStore.js:33-43` | ~½ day | Encrypt the buffer with `lib/fieldEncryption.js` (AES-256-GCM) before write; decrypt on the authenticated download path. **Do this first** — passport/bank scans in plaintext is a compliance risk. |
| A2 | **FR-5.2 consumer missing** (template → quote) | NOT FOUND | ~1 day | Add "Apply quotation template" in the visa quote flow: fetch template lines → create an `Itinerary` (`subBrand="visa-sure"`) pre-filled. |
| A3 | **FR-3.2: rejection-history never populated** | `routes/travel_diagnostics.js` (no refs) | ~½ day | At diagnostic submit, derive `priorRejectionCount`/`rejectionHistoryJson` from the relevant answers; mirror onto `VisaApplication` at create. Unblocks FR-3.1(b) too. |
| A4 | **FR-3.1(c): `familySize` not consumed** | `schema.prisma:6140`; engine no-ref | ~½ hr | Add the rule in `visaRiskFlagEngine.js` (`familySize > N` → complex). Column already exists. |
| A5 | **NFR retention: visa models unmapped** | `cron/retentionEngine.js` ENTITY_MAP | ~½ day | Add `VisaApplication` (84 mo post-`decidedAt` for rejection history) + `VisaDocumentChecklistItem` (24 mo) to the ENTITY_MAP + seed `RetentionPolicy` rows. |
| A6 | **FR-8: Reports link missing from sidebar** | `Sidebar.jsx:1596-1601` | ~10 min | Add the Reports child link to the Visa Sure nav group (route already mounted). |
| A7 | **Diagnostic report email delivery** | `routes/travel_diagnostics.js:403-513` | ~½ day | Wire the existing SendGrid sender to email the generated PDF on submit (SendGrid is configured). WA stays Q9-blocked. |
| A8 | **Email-OTP API bypass** | `routes/auth.js` register/signup; `routes/portal.js:116-138` | ~1 hr + test updates | Make the `verificationToken` **required** (not just UI-gated). Update the ~5 affected register/signup tests. |
| A9 | **FR-7 secondary metrics** | `travel_visa_analytics.js` | ~1 day | Add time-to-file/decision, tier-mix, advisor-productivity (data already on `VisaApplication`: `createdAt/filedAt/decidedAt`). |

### B — Decision-blocked (need a product call before building)

| # | Gap | PRD ref | Blocking question |
|---|---|---|---|
| B1 | High-rejection-rate destination signal (FR-3.1(d)) | PC-3 / PC-7 | Do we model per-embassy rejection rates, and who maintains the catalogue? Engine ships a proxy today. |
| B2 | EmbassyRule consumption breadth | PC-1..PC-5 | Which rule types feed the checklist/risk engines (document-required, interview-required, funds)? Model + CRUD exist; only cooldown is wired. |
| B3 | Recovery diagnostic reuse vs retake | PC-2 | Does the recovery program reuse the original diagnostic + a follow-up Q-set, or a full retake? |
| B4 | Recovery cool-down gate (FR / PC-4) | PC-4 | Does the system enforce `createdAt > decidedAt + cooldown`, or just advise? |
| B5 | FR-3.1(b) `priorRejectionCount` column | PC-1 | Confirm the complex-case definition before adding the column (A3 supplies the data either way). |

### C — Cred-blocked

| # | Gap | Cred | Notes |
|---|---|---|---|
| C1 | `visa-summary` LLM (FR-4 AI notes) | Q11 (LLM keys) | UI placeholder + router stub pattern ready; flips on when keys land. |
| C2 | WhatsApp advisor alerts (FR-3.3) + diagnostic WA delivery (FR-1.3) | Q9 (Wati BSP) | `Notification` row already created; WA dispatch is the only missing leg. |
| C3 | Passport OCR for uploaded docs (FR-6 enhancement) | C-cluster OCR | Optional; the portal already shares the passport-upload storage posture. |

### D — Brand-asset-blocked (Yasin Q22 brand pack)

| # | Gap | PRD ref |
|---|---|---|
| D1 | Visa-Sure PDF brand template + tone/copy (FR-1.3/FR-2) | FR-1.3 |
| D2 | `frontend/src/theme/visa-sure.css` palette (FR-8.3) | FR-8.3 |
| D3 | Visa quote-PDF branding (FR-5.3) | FR-5.3 |

---

## 4. Recommended sequencing

1. **A1 — encrypt documents at rest** (security; ~½ day). Highest priority.
2. **A3 + A4** — populate rejection-history at submit + consume `familySize`
   (makes the risk engine's FR-3.1/3.2 faithful; ~1 day combined).
3. **A2 — quotation-template consumer** (completes FR-5.2 end-to-end; ~1 day).
4. **A5 — visa retention rows** (compliance; ~½ day).
5. **A6 + A7 + A8 + A9** — quick wins (Reports link, email delivery, OTP
   hard-enforce, secondary analytics).
6. Hold **B1–B5** for the next product call with Yasin (they're PRD-tracked
   PC-1..PC-8 decisions, not engineering gaps).
7. **C1–C3 / D1–D3** flip on automatically when the Q11 / Q9 / OCR creds and the
   Q22 brand pack land — the seams are already in place.

---

## 5. Notes

- Counts/line numbers reflect the current working tree on 2026-06-16; a few
  totals (e.g. analytics endpoint count) **exceed** the PRD because bonus
  time-series endpoints shipped.
- Items D1–D3 + C1–C3 match the PRD's own §5.2 cred-chase / §6 deferral notes —
  they are tracked, not overlooked.
- This analysis is scoped to **Visa Sure Phase 3 + the travel customer-portal /
  auth work** (the active surface). A whole-CRM gap sweep is a separate exercise.

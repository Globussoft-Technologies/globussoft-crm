# Visa Sure (Phase 3) — Product Requirements

**Status:** SPEC — sub-brand is **Phase 3** of the Travel CRM build (per
[TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md](TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md)
Portal 4 / [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md) cluster B3).
Schema-only today (`VisaApplication` + `VisaDocumentChecklistItem` shipped at
commit `78884e3`, seeded with 4 checklist items). No routes, no UI, no
risk-flag engine. Estimated engineering time after this PRD is signed off:
**~2 weeks** for cluster B3.

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §4 (sub-brand
ladder) + §4.7 (operating model). Phase 1 launches TMC and RFU; Phase 2 ships
Travel Stall depth; Phase 3 is Visa Sure end-to-end.

**Audience:** Yasin (Visa Sure brand owner, per
`travel-crm/Visa Sure - CRM development.pdf` + `Visa_Sure_Business_Blueprint (1).pdf`),
GS engineering (the implementers of cluster B3), Travel Stall ops (the team
who will service Visa Sure leads as advisors).

---

## 1. Background

Visa Sure is the fourth sub-brand on the Travel CRM tenant (after TMC, RFU,
Travel Stall). It is the only one positioned **explicitly as a non-filing
service** — a **Visa Correctness & Assurance Brand** that diagnoses readiness
*before* any commercial transaction. The CRM build follows the same diagnostic-
first, advisor-mediated pattern already shipped for TMC and RFU, with two
genuinely Visa-Sure-specific additions: a **rejection-recovery program** for
applicants with a prior visa refusal, and a **risk-flagging engine** that
elevates complex / high-rejection-history cases for advisor priority.

### 1.1 Source attribution

The Visa Sure requirements originate from **two source documents in
`travel-crm/`**, both authored by Yasin and his team:

> **Visa Sure CRM structure brief** (`Visa Sure - CRM development.pdf`,
> 1 page, structural feature list)
>
> *"Visa Sure is a Visa Correctness and Assurance brand. It diagnoses
> readiness before any commercial transaction."*
>
> Product ladder: (1) Visa Readiness and Correctness Check, (2) Correctness
> Assured Visa Program, (3) Rejection Recovery and Re-application Program.
>
> CRM functional requirements: diagnostic engine (15 questions, 4 readiness
> levels, editable logic, PDF report) · risk flagging (complex case flags,
> rejection history tagging, advisor priority alerts) · advisor dashboard
> (diagnostic answers visible, AI summary notes, risk indicators) ·
> quotation (manual or structured, stored in CRM) · document upload
> (structured checklist, status tracking) · analytics (rejection recovery
> success rate, conversion by readiness level, lead source to application
> rate).

> **Visa Sure — Business Blueprint v1.0** (`Visa_Sure_Business_Blueprint (1).pdf`,
> 12 pages, dated 2026-02-09, positioning + customer journey + tech ops)
>
> *"Our core promise is simple: 'We ensure your visa application is done
> correctly, calmly, and without being taken for a ride.'"*
>
> Three customer fears addressed: rejection · being taken for a ride by
> agents · procedural / emotional unpreparedness. Funnel is **non-transactional
> at the outset** — packages and prices are never shown before diagnostic +
> human conversation. AI is **internal-only** (classification + risk patterns
> + PDF templating + advisor insights); never customer-facing.

**Position relative to TMC / RFU.** The diagnostic plumbing
([backend/routes/travel_diagnostics.js](../backend/routes/travel_diagnostics.js)
+ [backend/lib/travelDiagnosticScoring.js](../backend/lib/travelDiagnosticScoring.js))
is already shared by TMC (7-question school-trip bank) and RFU (15-question
Umrah readiness bank). Visa Sure reuses that plumbing wholesale — a new
question-bank row + a new scoring-rules row + a new sub-brand slug
(`"visa-sure"`) + a new PDF template are enough to light up FR-1..FR-2.
**What's genuinely new** for Visa Sure: the rejection-recovery workflow
(FR-3 risk-flag engine + FR-7 recovery-rate analytics), the visa-specific
document checklist (FR-6), and the visa-specific advisor dashboard surface
(FR-4). Everything else is reuse.

**Source-of-truth chain:**

```
Yasin's Visa Sure brief (travel-crm/Visa Sure - CRM development.pdf)
  └─ Visa Sure Business Blueprint v1.0 (Visa_Sure_Business_Blueprint (1).pdf)
       └─ this PRD (live)
            └─ MANUAL_CODING_BACKLOG.md cluster B3 (~2 weeks engineering)
                 └─ TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md rows V1-V19
                      └─ implementation tick (Phase 3)
```

---

## 2. Use cases — customer + operator flows

### 2.1 The three-product ladder

Per Yasin's brief (§3 of the blueprint) — sold **organically out of the
diagnostic**, never as a pre-priced menu:

| # | Product | Tier | Audience | Pricing posture |
|---|---|---|---|---|
| 1 | **Visa Readiness & Correctness Check** | Entry (free) | Anyone considering a visa application; first interaction with the brand | Free — credited toward the primary product fee if the applicant converts |
| 2 | **Correctness-Assured Visa Program** | Primary (core revenue) | Applicants diagnosed at Level 2 / Level 3 / Level 4 readiness; the mass-market customer | Tailored quotation per applicant — never a fixed package price |
| 3 | **Rejection Recovery & Re-application Program** | Premium (high-margin) | Applicants with prior visa rejection (priorRejectionCount ≥ 1); white-glove dedicated-advisor service | Tailored quotation, higher margin than the primary |

The CRM does NOT auto-recommend a tier as a hard rule — it surfaces the
**readiness level** (1-4) and the **risk indicators** (complex case, prior
rejections) to the advisor, who then prescribes the tier in conversation.

### 2.2 Four readiness levels

Per blueprint §4.2.1 — same labels as RFU, calibrated for visa applicants:

| Level | Name | Meaning | Tone |
|---|---|---|---|
| 1 | **Confident & Prepared** | Familiar with visa process, comfortable managing steps independently | Affirming, respectful |
| 2 | **Guided for Peace of Mind** | Understands process broadly, benefits from structured guidance to avoid oversights | Supportive, normalizing |
| 3 | **Assisted for Comfort & Correctness** | Experienced support will significantly improve application's chances | Caring, protective |
| 4 | **Supported Journey Recommended** | Fully supported journey strongly advised (complex case, family with dependents, high-anxiety) | Dignified, safety-first |

### 2.3 Customer journey (end-to-end)

Per blueprint §4.1 — the funnel is intentionally **non-transactional** until
after a human conversation:

1. **Entry & Diagnosis.** Lead reaches the Visa Sure landing page (or is
   routed from a TMC / RFU / Travel Stall context) → takes the 15-question
   **Visa Readiness & Assurance Review** (free, no payment, no signup wall).
2. **Authority & Reassurance.** Lead receives on-screen Readiness Level +
   short explanation immediately. PDF report emailed (and WA-delivered post-Q9)
   within 60 s. Diagnostic-completion triggers a CRM alert; advisor receives
   priority signal (FR-3 risk flag) within 5 min if applicable.
3. **Prescription.** Advisor calls within 24 h. Reassurance conversation, NOT
   a sales call. Advisor reviews diagnostic answers (FR-4), discusses risk
   indicators, prescribes a tier (primary vs premium) based on case profile.
4. **Quotation & Booking.** Advisor generates a tailored quotation (FR-5 —
   manual or structured per case) → CRM stores quotation PDF → customer
   accepts → application enters `intake` status → document collection (FR-6).
5. **Application lifecycle.** Status progresses through `intake` →
   `docs-pending` → `filed` → `approved` / `rejected` / `appeal`. Document
   checklist (FR-6) drives the docs-pending → filed transition.
6. **Outcome handling.**
   - **Approved**: standard close-out, post-trip feedback, repeat-customer
     marketing flow.
   - **Rejected**: application automatically enters rejection-recovery flow
     (FR-3 + recoveryProgramId). Advisor re-engages, recovery quotation
     generated, second application filed. Outcome of recovery tracked
     separately for FR-7 analytics ("rejection recovery success rate").

### 2.4 Operator journey

Visa Sure advisors are shared with the rest of the travel CRM (per Q25 — single
tenant, `subBrandAccess[]` per User). Day-in-the-life flow:

1. Advisor logs in → lands on operator dashboard. Sees **Visa Sure leads
   queue** scoped to their `subBrandAccess`.
2. New diagnostic completes → advisor receives priority alert (FR-3) if the
   case is flagged complex / prior-rejection / Level 4.
3. Advisor opens lead detail → sees diagnostic answers (FR-4), risk
   indicators, AI summary (FR-4 LLM consumer), recommended tier.
4. Advisor calls lead, captures notes via Activity model, generates quotation
   (FR-5).
5. After acceptance, advisor drives document checklist (FR-6), uploading or
   marking documents collected. Status auto-advances when checklist 100%
   complete.
6. Application filed → advisor records `filedAt`. Outcome recorded via
   `outcome` + `outcomeReason`. Rejected applications trigger the FR-3
   rejection-recovery workflow.

### 2.5 What's reused vs new

| Capability | Reused from TMC / RFU | New for Visa Sure |
|---|---|---|
| Diagnostic engine ([routes/travel_diagnostics.js](../backend/routes/travel_diagnostics.js)) | ✅ All endpoints + scoring engine ([lib/travelDiagnosticScoring.js](../backend/lib/travelDiagnosticScoring.js)) | New `visa-sure` sub-brand slug + new question bank + new scoring rules |
| PDF report generator ([services/pdfRenderer.js](../backend/services/pdfRenderer.js)) | ✅ Same `renderTravelDiagnosticPdf` helper | New Visa Sure brand template (logo / palette / copy) |
| LLM router ([lib/llmRouter.js](../backend/lib/llmRouter.js)) | ✅ Talking-points + form-vs-call tasks | New `visa-summary` task type for FR-4 AI summary |
| Quotation surface | ✅ `Itinerary` model reusable; quotation PDF helper reusable | Visa Sure pricing not seasonal (no `TravelSeasonCalendar` dependency); tariffs are per-destination-embassy |
| Document upload + storage | ✅ Encrypted via [lib/fieldEncryption.js](../backend/lib/fieldEncryption.js); same passport pattern TMC uses | New `VisaDocumentChecklistItem` workflow + status tracking surface |
| Risk-flag engine | ❌ Not shared — TMC / RFU don't have one | **New cron** `backend/cron/visaRiskFlagEngine.js` |
| Rejection-recovery workflow | ❌ Not shared | **New** `VisaApplication.recoveryProgramId` linkage + workflow |
| Advisor dashboard | ✅ Same `LeadDetail.jsx` pattern | New Visa Sure subroutes under `/travel/visa/*` |
| Analytics | ✅ Same `routes/travel_reports.js` pattern | New `/reports/visa` endpoint for FR-7 metrics |

---

## 3. Functional requirements

### FR-1 — Diagnostic engine (rows V1-V3)

| FR-ID | Requirement | What's shared | What's Visa-Sure-specific |
|---|---|---|---|
| FR-1.1 | 15-question Visa Readiness & Assurance Review, weighted scoring, classification into 4 readiness levels | Plumbing: `routes/travel_diagnostics.js` POST `/diagnostics` + `lib/travelDiagnosticScoring.js` `weighted-sum` method | New question bank seeded with 15 visa-specific Qs across 5 sections (Basic Context / Preparation & Confidence / Support Preference / Practical & Emotional Factors / Planning Style — per blueprint §4.2.2) |
| FR-1.2 | Editable scoring logic from admin panel | Plumbing: POST `/diagnostic-banks` admin endpoint already shipped (versioned bank model, latest active wins) | New scoring rules JSON seeded with Visa Sure band thresholds + tier mappings |
| FR-1.3 | Auto-generated PDF report (branded as Visa Sure, emailed to applicant + WA-delivered post-Q9) | `renderTravelDiagnosticPdf` helper, best-effort PDF generation pattern, `/uploads/diagnostics/` storage | New `templates/visa-sure.pdfkit.js` brand template; copy + classifications reflect visa-specific tone (per blueprint §4.2.1 tone column) |

### FR-2 — PDF report generation (row V4)

Folded into FR-1.3 above — the diagnostic-completion PDF is the same surface
as TMC / RFU, with a Visa Sure brand variant. **Status: PARTIAL (PDF infra
shared; Visa Sure template content pending Yasin Q22-equivalent brand drop).**

### FR-3 — Risk-flagging engine (rows V5-V7)

The risk-flag engine is **new for Visa Sure** — TMC / RFU don't surface
complexity / rejection-history as first-class signals because their domains
don't have a "rejection" outcome class.

| FR-ID | Requirement | Implementation |
|---|---|---|
| FR-3.1 | **Complex case flagging** — applicant marked complex when (a) applicationType ∈ {work, student, business, hajj} OR (b) priorRejectionCount ≥ 1 OR (c) family/dependents in the trip OR (d) destination is a high-rejection-rate embassy | New cron `backend/cron/visaRiskFlagEngine.js` — runs every 15 min, scans `VisaApplication` rows in status ∈ {intake, docs-pending}, computes `complexCase` + `advisorRiskFlag` |
| FR-3.2 | **Rejection-history tagging** — `priorRejectionCount` populated from diagnostic answer to Q "have you been refused a visa before?"; `priorRejectionReasons` (JSON array of `{country, date, reason}`) populated from follow-up Qs | Stamped at diagnostic submit time; mirrored to `VisaApplication.rejectionHistoryJson` when application created |
| FR-3.3 | **Advisor priority alerts** — within 5 min of a high-risk flag transition, advisor receives in-app notification + WA alert (post-Q9). High-risk = `advisorRiskFlag ∈ {high, priority}` OR readinessLevel = 4 OR rejection history non-empty | Cron reuses the existing `Notification` model + `WhatsAppMessage` stub-dispatch pattern (subBrandConfig helper handles WABA selection — already shipped at commit `621aab7`) |

The cron's run cadence + cluster B3 ownership: the engine itself is **a new
file** (`backend/cron/visaRiskFlagEngine.js`) **shipped by the sibling
parallel agent on this same tick** if the wave succeeds — this PRD's
ownership is the contract, not the code; the spec assumes the engine ships
in the same wave to honour the §10 NOT-STARTED → SHIPPED transition.

### FR-4 — Advisor dashboard (rows V8-V10)

Three new pages under `/travel/visa/*`:

| Page | Route | Purpose |
|---|---|---|
| **Application list** | `/travel/visa/applications` | Sortable / filterable list of `VisaApplication` rows. Filters: status, advisorRiskFlag, readinessLevel, applicationType, destinationCountry. Risk indicators surfaced as coloured chips. |
| **Application detail** | `/travel/visa/applications/:id` | Full lead view: diagnostic answers (rendered as Q/A list, not raw JSON), risk indicators (complex / prior-rejection / readinessLevel chips), AI summary notes (FR-4 LLM consumer — new `visa-summary` task), document checklist (FR-6), status timeline, advisor activity log, quotation history |
| **Checklist admin** | `/travel/visa/checklists` | Admin: manage the per-applicationType document checklist templates (e.g. "tourist USA" needs passport + photo + bank statements + travel insurance; "student UK" needs additional CAS letter + maintenance proof). |

LLM consumer: new task `visa-summary` in `lib/llmRouter.js` — given a
`VisaApplication` + linked `TravelDiagnostic` + applicable risk flags, produce
an advisor-facing summary covering (a) what jumped out from the diagnostic,
(b) which risks elevate the case, (c) suggested talking points for the
reassurance call. **Stub-mode until Q11 LLM keys land** (same pattern as
existing talking-points consumer).

### FR-5 — Quotation (rows V11-V12)

Reuse the existing `Itinerary` infrastructure for storage; quotation surface
is a new dialog in the application detail page.

| FR-ID | Requirement | Implementation |
|---|---|---|
| FR-5.1 | **Manual quotation** — advisor enters line items (service tier base price + adjustments — credit the free entry diagnostic fee, embassy-specific adjustments, etc.) | New `frontend/src/pages/travel/visa/QuoteBuilder.jsx`; reuses `Itinerary` model with `productTier ∈ {primary, premium}` |
| FR-5.2 | **Structured quotation** — for standard cases, advisor selects from a curated quotation template (tourist visa / business visa / student visa) and the system auto-populates line items | Templates stored in a new `VisaQuotationTemplate` model; admin manages via `/travel/visa/checklists` page (the checklist admin page extends to manage quotation templates too) |
| FR-5.3 | **PDF quotation** — generated from the same `pdfRenderer.js` infrastructure as the diagnostic report; Visa Sure branded | Reuse pattern; new `templates/visa-quote.pdfkit.js` brand template |
| FR-5.4 | **Stored in CRM** | All quotation rows persist as `Itinerary` (linked via `Itinerary.subBrand = "visa-sure"`); accessed via existing `routes/travel_itineraries.js` |

### FR-6 — Document upload + checklist (rows V13-V15)

| FR-ID | Requirement | Implementation |
|---|---|---|
| FR-6.1 | **Structured checklist per applicationType + destinationCountry** | New endpoint `GET /api/travel/visa/checklists/template?applicationType=tourist&destinationCountry=US` returns the canonical checklist items; admin manages templates via `/travel/visa/checklists` |
| FR-6.2 | **Per-application document upload** | New endpoints `POST /api/travel/visa/applications/:id/documents` (upload, `multipart/form-data`) + `PATCH /api/travel/visa/documents/:id/status` (verify/reject) |
| FR-6.3 | **Status tracking** — each `VisaDocumentChecklistItem` cycles through `pending` → `uploaded` → `verified` / `rejected`; rejected items must be re-uploaded | Already in schema (`VisaDocumentChecklistItem.status` enum exists); needs UI + routes |
| FR-6.4 | **Encrypted at rest** — passport scans + Aadhaar + supporting docs encrypted via existing AES-256-GCM helper | `backend/lib/fieldEncryption.js` (already shipped, used by TMC participant passport columns) |
| FR-6.5 | **Auto-status-advance** — when 100% of `required: true` checklist items reach `verified`, `VisaApplication.status` auto-advances `docs-pending → filed-ready` | Hook into the existing application update endpoint; emit a Notification on transition |

### FR-7 — Analytics (rows V16-V18)

New `/reports/visa` endpoint extending [routes/travel_reports.js](../backend/routes/travel_reports.js):

| Metric | Definition | Sources |
|---|---|---|
| **Rejection recovery success rate** | `(applications in recoveryProgram with outcome=approved) / (applications in recoveryProgram total)` | `VisaApplication.recoveryProgramId IS NOT NULL` + `outcome` |
| **Conversion by readiness level** | For each level 1-4: `(applications with status ∈ {filed, approved}) / (diagnostics in that level)` | Join `TravelDiagnostic.classification` to `VisaApplication.status` |
| **Lead source to application rate** | For each `Contact.firstTouchSource`: `(applications) / (leads with that source)` | Join `Contact.firstTouchSource` to `VisaApplication.status ≠ "intake"` |

Plus secondary metrics that the blueprint hints at: avg-time-to-file
(`createdAt → filedAt`), avg-time-to-decision (`filedAt → decidedAt`), tier
mix (% entry / % primary / % premium), advisor productivity (applications
filed per advisor per month).

### FR-8 — Landing route + sidebar nav (row V19)

| FR-ID | Requirement | Implementation |
|---|---|---|
| FR-8.1 | **Sidebar nav** — `renderTravelNav()` in `frontend/src/components/Sidebar.jsx` gains a "Visa Sure" group with 3 child links (Applications / Checklists / Reports) | Visible only to users with `"visa-sure" ∈ subBrandAccess` |
| FR-8.2 | **Landing route** — `/travel/visa` lands users on the application-list page | Mounted in `frontend/src/App.jsx` Suspense lazy-load block |
| FR-8.3 | **Brand theming** — Visa Sure brand palette swappable per `[data-vertical="travel"][data-sub-brand="visa-sure"]` CSS scope (placeholder palette pending Yasin brand handover, same as Travel Stall today) | New `frontend/src/theme/visa-sure.css`; activated by the existing sub-brand-switcher mechanism in `Sidebar.jsx` |

---

## 4. Non-functional requirements

| NFR | Target | Notes |
|---|---|---|
| **Latency** (diagnostic submit → classification + PDF in response) | < 10 s p95 | PDF generation is best-effort; if it exceeds 10 s the classification still returns and PDF generation retries via the existing fallback. |
| **Latency** (risk-flag re-evaluation on application update) | < 5 min p95 (cron tick + run time) | Cron runs every 15 min; for time-critical advisor priority alerts we accept up to 15 min lag (matches the existing leadSlaEngine cadence). |
| **Latency** (advisor dashboard list page initial load with 200 applications) | < 2 s p95 | Pagination at 50 rows per page; index `(tenantId, status, advisorRiskFlag)` already in schema. |
| **Compliance — retention** | Visa documents (passport scans, supporting docs) retained 24 months post-`decidedAt`; rejection-history data retained 84 months (UIDAI + tax-audit alignment) | Reuses `backend/cron/retentionEngine.js` with new `RetentionPolicy` rows for `VisaApplication` + `VisaDocumentChecklistItem` |
| **Compliance — encryption at rest** | All visa documents encrypted via `fieldEncryption.js` (AES-256-GCM, per-tenant keys); rejection-history JSON also encrypted | Sensitive — rejection history is reputational data; treat at the same tier as passport scans |
| **Reliability — risk-flag cron** | If the cron silently fails (no risk-flag transitions for ≥ 1 h on a tenant with ≥ 1 new application), surface a `demo-monitor`-style alert | Reuses the existing `backend/cron/demoHygieneEngine.js` health-probe pattern |
| **Reliability — rejection-history data quality** | The cron must NOT crash on missing / malformed `rejectionHistoryJson`; degrades to "no rejection history detected" + non-fatal warning to advisor | Defensive parsing with try/catch — mirror the existing `parseBank` pattern in `lib/travelDiagnosticScoring.js` |
| **Observability** | LLM cost per `visa-summary` call logged to `LlmCallLog` (already shipped); per-tenant monthly budget cap respected | Reuses `LlmSpend.jsx` admin dashboard (commit `76996c8`) |

---

## 5. Hand-over requirements / decisions needed

This is the section that needs Yasin + product-call sign-off **before** the
cluster B3 engineering work starts.

### 5.1 Product calls (PRODUCT-CALL items — open issues for stakeholder decisions)

| # | Decision needed | Owner | Why blocking |
|---|---|---|---|
| **PC-1** | **What counts as a "complex case" for the risk-flag engine (FR-3.1)?** Current proposal: applicationType ∈ {work, student, business, hajj} OR priorRejectionCount ≥ 1 OR family/dependents OR high-rejection-rate destination. Yasin to confirm OR refine. | Yasin | The cron's primary signal logic depends on this; we'd rather pin it once than ship + re-tune. |
| **PC-2** | **Does rejection-recovery require a NEW diagnostic or reuse the original one?** Two options: (a) the recovery program reuses the applicant's existing diagnostic answers + adds a "rejection context" follow-up Q-set; (b) the applicant retakes the full 15-Q diagnostic from scratch under the recovery program context. | Yasin + advisor team | Drives whether `RejectionRecoveryProgram` links 1:N to `TravelDiagnostic` or to `VisaApplication`. |
| **PC-3** | **Per-destination embassy quirks (US vs UK vs Schengen vs UAE) — do we model these?** Two options: (a) Phase 3 ships a generic checklist + advisor notes; embassy-specific rules stay in the advisor's head. (b) Phase 3 ships a `VisaEmbassyRule` model that the checklist template engine reads + the risk-flag engine consults (e.g. "US student visa needs Form I-20 + SEVIS fee proof + financial docs covering full programme length"). | Yasin | Heavy schema work if (b) — adds ~3 days to cluster B3. We need the call before committing. |
| **PC-4** | **Rejection-recovery time window — how soon after rejection can a customer re-apply?** Some embassies impose cool-down (e.g. US-B1/B2 typically allows immediate re-apply; UK has no formal cool-down but recommends re-apply only after addressing the refusal reason; Schengen has no formal cool-down). Does the CRM enforce a time gate or just surface advisor-facing guidance? | Yasin + counsel | Drives whether the recovery-program creation endpoint enforces a `createdAt > decidedAt + cool-down-days` check. |
| **PC-5** | **Visa categories in scope for Phase 1 of Phase 3.** Tourist + business + family + student is clearly in scope; what about transit, work, dependent, medical, journalism, religious-pilgrimage visas? Each has different document checklists + risk profiles. | Yasin | Adding categories post-launch is cheap (just new checklist templates); but agreeing the launch set scopes the seed data. |
| **PC-6** | **Region focus.** Is Visa Sure (a) US-outbound only, (b) India-outbound to any country, (c) any-region-to-any-region? | Yasin | India-outbound is the safe Phase-3 default (matches RFU's geography). Cross-region multiplies the embassy-rule complexity in PC-3. |
| **PC-7** | **Embassy-quirk catalogue maintainer.** Once shipped, who keeps the per-country / per-visa-type rule database current? Embassy rules change quarterly. | Yasin + advisor team | If no maintainer is named, the system goes stale within 6 months. Could be an advisor-curated wiki, an admin-UI CRUD surface, or an outsourced data feed. |

### 5.2 Cred chase

**None unique to Visa Sure.** All cred-blocked dependencies inherit from
existing Travel CRM creds:

- LLM keys (Q11) — for FR-4 `visa-summary` task; same blocker as RFU
  talking-points / form-vs-call.
- WA dispatch (Q9) — for FR-3 advisor priority alerts; same blocker as
  every other travel sub-brand.
- Passport OCR (cred-dependent C-cluster) — for FR-6 document upload's
  optional auto-extraction; cluster B3 can ship without it (manual entry +
  human verification).

Visa Sure does **NOT** add a new cred ask. This is unique to the sub-brand —
TMC needs DigiLocker + Drive; RFU needs RateHawk; Travel Stall would need
Booking/Expedia. Visa Sure is pure-CRM scope.

### 5.3 Vendor docs

**None external.** No direct embassy APIs (see §7 — out of scope), no
visa-system integrations. The build is internal CRM only.

---

## 6. Acceptance criteria

The Visa Sure Phase 3 build is "done" when **all 6 of the following are
demonstrable** on the demo box:

| # | Test | Verifies |
|---|---|---|
| AC-1 | A customer submits the 15-question Visa Readiness & Assurance Review → receives Readiness Level on-screen + PDF report within 10 s. | FR-1 (diagnostic engine) + FR-2 (PDF generation). |
| AC-2 | An advisor opens a new Visa Sure lead detail page → sees the customer's diagnostic answers, risk indicators (complex case / rejection history / readiness level chips), AI summary (or stub text under Q11 stub mode), and recommended tier. | FR-4 (advisor dashboard) + FR-3.2 (rejection-history tagging). |
| AC-3 | An application is marked `complexCase=true` (via diagnostic OR manual flag) → within 5 min (one cron tick + propagation) the assigned advisor receives an in-app notification + queued WA priority alert. | FR-3.3 (advisor priority alerts) + the new `visaRiskFlagEngine.js` cron. |
| AC-4 | A rejected application enters the recovery flow (`recoveryProgramId` set) → the analytics dashboard at `/reports/visa` shows the recovery success rate metric correctly aggregated across all recovery applications. | FR-7 (analytics — rejection recovery success rate) + the full lifecycle. |
| AC-5 | Each of `/travel/visa/applications`, `/travel/visa/applications/:id`, `/travel/visa/checklists` renders correctly under both user roles (ADMIN + advisor with `subBrandAccess=["visa-sure"]`); USER role without sub-brand access gets `403 SUB_BRAND_DENIED`. | FR-8 (landing route + sidebar nav) + the sub-brand access middleware. |
| AC-6 | Document checklist for a `tourist + US` application auto-populates with the canonical doc list (passport + photo + bank statements + travel insurance); uploading + verifying each item advances `VisaApplication.status` from `docs-pending` to `filed-ready` when 100% of required items are `verified`. | FR-6 (document upload + checklist + auto-status-advance). |

GS owns the e2e validation (Playwright gate spec at
`e2e/tests/visa-applications-api.spec.js` + a UI smoke spec); Yasin owns
acknowledging acceptance of the demo walkthrough.

---

## 7. Out of scope

- **Direct embassy API integrations.** Embassy / consulate systems do not
  generally expose APIs for third-party submissions. Visa Sure is an
  **assurance + correctness brand**, not a filing service — the application
  is still submitted through official channels by the applicant or their
  advisor, NOT by the CRM.
- **Automated visa-form-filling.** Legal grey area — many embassies'
  terms-of-service prohibit third-party form auto-completion. Needs a
  separate product + legal-counsel decision; out of scope for Phase 3.
- **Visa interview prep / mock interviews.** Plausible Phase 4 product
  (a new tier above the current premium "rejection recovery" tier); not
  in this PRD's scope.
- **Real-time visa-fee currency conversion** (e.g. live USD → INR for US
  visa fees). Phase 3 uses the static rate stored in
  `TravelCostMaster`; live rates are a Phase 1.5 / Phase 2 nice-to-have.
- **Customer-facing "AI" copy.** Per blueprint §5.2 — AI is internal only;
  the customer experience is always positioned as Visa Sure's
  expertise + advisor care. No "ChatGPT for visas" customer-facing surface.
- **Insurance + flight + hotel cross-sell.** Visa Sure's brand promise is
  narrow ("correctness + assurance for the visa application itself"); travel
  cross-sells route through Travel Stall as a separate funnel, NOT bundled
  into the Visa Sure quotation.

---

## 8. Dependencies + downstream

- **Shared diagnostic plumbing** ([routes/travel_diagnostics.js](../backend/routes/travel_diagnostics.js)
  + [lib/travelDiagnosticScoring.js](../backend/lib/travelDiagnosticScoring.js))
  — already used by TMC and RFU; no additional code, just seed data.
- **LLM router** ([lib/llmRouter.js](../backend/lib/llmRouter.js)) for FR-4
  AI summary; Q11 cred-dependent.
- **PDF renderer** ([services/pdfRenderer.js](../backend/services/pdfRenderer.js))
  + brand template additions for Visa Sure.
- **Field encryption** ([lib/fieldEncryption.js](../backend/lib/fieldEncryption.js))
  for FR-6 document storage; already shipped, reused.
- **Retention engine** ([cron/retentionEngine.js](../backend/cron/retentionEngine.js))
  + new `RetentionPolicy` rows for `VisaApplication` and
  `VisaDocumentChecklistItem`.
- **Risk-flag cron** (new — `backend/cron/visaRiskFlagEngine.js`) — shipped
  by the sibling parallel agent on the same tick as this PRD if the wave
  succeeds, otherwise as the first commit of the cluster B3 work.
- **subBrandConfig helper** ([lib/subBrandConfig.js](../backend/lib/subBrandConfig.js))
  — already shipped (commit `621aab7`); FR-3.3 WA priority alerts will route
  through the ops-shared WABA (visa advisors are operator-side, not customer-side).
- **Voyagr (OJR) lead-capture integration** — `POST /api/v1/voyagr/leads`
  endpoint (commit `0299031`) already supports `subBrand=visa-sure` for
  lead capture from the Visa Sure website; Voyagr-side form (cluster F2)
  pending.

**Downstream effects on shipped code:**

- `frontend/src/components/Sidebar.jsx` `renderTravelNav()` gains a Visa Sure
  group — additive; doesn't disturb TMC / RFU / Travel Stall navigation.
- `prisma/seed-travel.js` extends to seed: 1 `TravelDiagnosticQuestionBank`
  for Visa Sure (15 Qs) + 1 scoring rules row + ~10 `VisaQuotationTemplate`
  rows (per applicationType × destination combos) + ~30
  `VisaDocumentChecklistItem` template rows (canonical lists per
  applicationType × destinationCountry).
- `routes/travel_reports.js` gains a `/reports/visa` endpoint — additive; no
  changes to TMC / RFU report endpoints.

---

## 9. Open questions

These are questions that surfaced during PRD authoring and need answers
before or during cluster B3 implementation. Distinct from §5.1 product
calls (those gate the engineering kickoff); these are smaller-scope
disambiguations that can be answered inline.

| # | Question | Owner |
|---|---|---|
| OQ-1 | **15-question content load.** The blueprint §4.2.2 names the 5 sections (Basic Context / Preparation & Confidence / Support Preference / Practical & Emotional Factors / Planning Style) but does NOT enumerate the 15 question texts + option weights. Yasin to deliver the question bank text + scoring rules. | Yasin |
| OQ-2 | **PDF report content.** The blueprint says "detailed, shareable PDF report" but doesn't specify the sections beyond "Readiness Level + explanation". GS proposal: cover page + readiness level + diagnostic-answer summary + section-by-section interpretation + recommended next-step CTA. Yasin to confirm + supply the copy. | Yasin |
| OQ-3 | **Rejection-recovery quotation mark-up.** The primary product has a "rule-based mark-up over base cost"; does the premium recovery program use a different mark-up? Higher? Same? Quoted manually per case? | Yasin |
| OQ-4 | **Email nudges.** The blueprint §5.3 mentions "soft, respectful, non-salesy email nudges for users who haven't responded after a certain period" — what's the cadence? Days 3 / 7 / 14 / 21 post-diagnostic? Different nudge per readiness level? | Yasin |
| OQ-5 | **Document-rejection retry budget.** If an uploaded document is rejected by an advisor (e.g. blurry passport scan), is there a retry limit before the application enters a stuck state? | Advisor team |
| OQ-6 | **Pricing of the entry-level "Visa Readiness & Correctness Check".** Blueprint §3.1 says "this is a low-friction, high-value diagnostic tool" but doesn't specify whether it's free, ₹X paid-but-credited-toward-primary, or something else. Current PRD proposal: free + credit toward primary. Yasin to confirm. | Yasin |
| OQ-7 | **Audit trail granularity.** Should `VisaApplication.status` transitions be append-only-logged (a `VisaApplicationStatusHistory` model)? Or just `updatedAt` + last-known-status? The compliance + dispute-resolution use case argues for append-only. | GS engineering + counsel |

---

## 10. Status snapshot

- **Diagnostic + scoring plumbing** ✅ SHIPPED (shared with TMC / RFU);
  [routes/travel_diagnostics.js](../backend/routes/travel_diagnostics.js) +
  [lib/travelDiagnosticScoring.js](../backend/lib/travelDiagnosticScoring.js).
- **Schema models** ✅ SHIPPED — `VisaApplication` at
  [prisma/schema.prisma:4498](../backend/prisma/schema.prisma#L4498) +
  `VisaDocumentChecklistItem` at `:4523`. Seeded with 4 sample rows
  (commit `78884e3`).
- **Visa Sure question bank + scoring rules seed** 🔴 NOT-STARTED — pending
  OQ-1 content drop from Yasin.
- **Routes** 🔴 NOT-STARTED — `/api/travel/visa/applications/*`,
  `/api/travel/visa/documents/*`, `/api/travel/visa/checklists/*`,
  `/api/travel/reports/visa` all to be built in cluster B3.
- **UI pages** 🔴 NOT-STARTED — `frontend/src/pages/travel/visa/*` does not
  exist; `Glob frontend/src/pages/travel/Visa*` returns zero.
- **Risk-flag cron** 🔴 NOT-STARTED — `backend/cron/visaRiskFlagEngine.js`
  does not exist; the sibling parallel agent on this same wave MAY ship
  a shell; if it doesn't, the cron is the first commit of cluster B3.
- **PDF brand template** 🔴 NOT-STARTED — pending OQ-2 content + Yasin brand
  assets (palette / logo).
- **Sidebar nav + landing route** 🔴 NOT-STARTED — additive change to
  `frontend/src/components/Sidebar.jsx` `renderTravelNav()` +
  `frontend/src/App.jsx` lazy-load block.
- **Voyagr-side Visa Sure form** 🔴 NOT-STARTED — cluster F2 in
  MANUAL_CODING_BACKLOG; would ship in tandem with the CRM-side go-live.

**Estimated engineering time once §5.1 product calls resolve:** ~2 weeks per
cluster B3 in MANUAL_CODING_BACKLOG. Breakdown: ~3 days schema + routes,
~3 days frontend (3 pages + nav + theme), ~2 days risk-flag engine + retention
policy + analytics endpoint, ~2 days seed + content load (diagnostic bank +
checklist templates + quotation templates + PDF template), ~2 days e2e
specs + vitest coverage + gate-wiring.

---

**Ownership chain:**

- **Yasin** owes the §5.1 product-call answers (PC-1..PC-7) + §9 content
  loads (OQ-1, OQ-2, OQ-3, OQ-4, OQ-6).
- **Advisor team** owes OQ-5 + the post-launch embassy-quirk catalogue
  maintenance (PC-7).
- **Counsel** owes OQ-7 (audit trail granularity) + PC-4 (rejection
  cool-down) input.
- **GS engineering** owes the ~2-week cluster B3 implementation after
  product calls clear, plus the gate-wiring + the e2e-full validation.

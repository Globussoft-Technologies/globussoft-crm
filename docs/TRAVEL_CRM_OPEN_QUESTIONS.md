# Travel CRM — Open Product Calls (Decision Log)

Companion to [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md). The PRD §12 lists 25 open
product calls that block kickoff. This doc carries each one with a decision
slot so we can walk through them one-by-one and record outcomes.

**Status legend:** 🟢 Decided · 🟡 In discussion · 🔴 Open (blocking) · ⚪ Out of scope

**Update protocol:** when a question is decided, update the **Decision** field, set
**Status** to 🟢, fill **Decided on** with the date, and mark blockers downstream
in the PRD if they're now unblocked.

---

## Priority tier 1 — CRITICAL · blocks Day 0 kickoff

These must land before any engineering work begins. The 6-week contractual
window starts on Day 0; every day delayed here pushes the ship date back.

### Q1 — Section 13 packet not yet delivered 🔴

**Source:** `Response` Part D; `Yasin clarifications` §3
**Owner:** Yasin (Travel Stall)
**Blocker for:** Day 0 kickoff (everything)

The packet must contain: TMC school DB, diagnostic Qs + scoring, RFU product
ladder + cost master, markup/GST/discount rules, airline portal creds + PNR
fields, RFU website URL + form fields, Workspace admin, WhatsApp numbers,
staff list + brand access, branding assets, templates, retention durations,
reminder schedules, TMC payment + rooming logic, KPI definitions, LLM keys,
manager users.

**Options:**
- (a) Wait for full packet (current plan; recommended)
- (b) Phased delivery: TMC items first (week 1), RFU items by W2
- (c) GS proposes defaults, Yasin signs off async

**Decision:** _________________________________
**Decided on:** _____________

---

### Q3 — DigiLocker partner credentials 🔴

**Source:** `Response` A.2
**Owner:** Yasin
**Blocker for:** Aadhaar OCR flow (TMC parent KYC + RFU pilgrim KYC)

DigiLocker requires registered partner credentials. If Travel Stall already
holds them, share. If not, GS initiates application (multi-week process via
NeGD; budget time accordingly).

**Options:**
- (a) Travel Stall has existing creds → share immediately
- (b) GS initiates new partner application (~3-6 week NeGD review)
- (c) Offline KYC fallback only for Phase 1; DigiLocker Phase 1.5

**Decision:** _________________________________
**Decided on:** _____________

---

### Q7 — SSO provider 🔴

**Source:** `Response` A.7 Q1
**Owner:** Yasin
**Blocker for:** W1 SSO setup

GS recommends Google Workspace (matches the demo CRM's existing SSO
integration). Alternative: Microsoft Entra ID (Office 365).

**Decision:** _________________________________
**Decided on:** _____________

---

### Q9 — WhatsApp numbers per brand 🔴

**Source:** `Response` A.7 Q3
**Owner:** Yasin
**Blocker for:** Wati BSP WABA provisioning (3 separate WABAs to isolate
brand inboxes)

Final allocation across TMC, RFU, ops-shared. Each WABA needs a verified
business number; meta verification is 5-7 business days.

**Decision:** _________________________________
**Decided on:** _____________

---

### Q10 — Final 8-status + 8-lost-reason labels 🔴

**Source:** `Response` A.7 Q4
**Owner:** Yasin
**Blocker for:** Pipeline seed for TMC + RFU

GS-proposed defaults (need confirmation):
- Status: New · Diagnostic Complete · Qualifying · Quoted · Negotiating · Won · Lost · Dormant
- Lost reason: Price · Date Conflict · Competitor · No-Show · Compliance Block · Out of Service Area · Customer Withdrew · Other

**Decision:** _________________________________
**Decided on:** _____________

---

### Q13 — Diagnostic length per brand 🔴

**Source:** `Response` A.7 Q10
**Owner:** Yasin
**Blocker for:** Diagnostic content load (TMC + RFU)

Need: number of questions, page-breaks, time-to-complete target per brand.
Reference: Visa Sure spec calls 15Q over 4 readiness levels.

**Decision:** _________________________________
**Decided on:** _____________

---

### Q14 — Document retention durations 🔴

**Source:** `Response` A.7 Q11; B.2
**Owner:** Yasin
**Blocker for:** Retention engine wiring (must seed before any PII lands)

GS proposal (confirm/override per document type):
- Passport: 24 months post-trip
- Aadhaar token: 24 months post-trip
- PAN: 24 months post-trip
- Visa application: 24 months
- Financial (invoice/payment): 84 months (statutory 7-year)
- Call recording: 12 months
- Diagnostic profile: lifetime-of-customer (never auto-purge)
- Contract: 24 months post-engagement

**Decision:** _________________________________
**Decided on:** _____________

---

### Q22 — Brand assets package 🔴

**Source:** Section 13
**Owner:** Yasin
**Blocker for:** All PDF / templated surfaces (diagnostic reports,
itineraries, invoices, microsites, email + WhatsApp templates)

Required per brand (TMC + RFU): logo (SVG + PNG @1x/@2x), color palette
(primary, accent, neutral scale), font stack (web + print fallback),
diagnostic PDF cover template, itinerary PDF template, invoice template.

**Decision:** _________________________________
**Decided on:** _____________

---

## Priority tier 2 — HIGH · blocks Phase 1 build start

### Q2 — Aadhaar consent legal copy 🔴

**Source:** `Response` A.2
**Owner:** Travel Stall counsel (drafted by GS)
**Blocker for:** Parent/teacher registration portal

GS drafts the consent text against Aadhaar Act requirements; Travel Stall
counsel reviews and signs off before production.

**Decision:** _________________________________
**Decided on:** _____________

---

### Q11 — Default LLM per task class 🔴

**Source:** `Response` A.7 Q6
**Owner:** Yasin
**Blocker for:** LLM router defaults

GS-proposed task → model routing (see PRD §9.1):
- Diagnostic interpretation → Perplexity (real-time search)
- Itinerary draft → Gemini 2.5
- AI qualification call → Gemini Live
- Document OCR fallback → Gemini Vision
- Sentiment / KPI insights → Gemini 2.5

Where are API keys held — GS-managed or Travel Stall AWS Secrets Manager?

**Decision:** _________________________________
**Decided on:** _____________

---

### Q12 — KPI reporting period defaults 🔴

**Source:** `Response` A.7 Q8
**Owner:** Yasin
**Blocker for:** Dashboards

Daily / weekly / monthly / custom? Same defaults across brands, or per-brand?

**Decision:** _________________________________
**Decided on:** _____________

---

### Q19 — Hotel rate comparator scope 🔴

**Source:** `Req Doc` §9 vs `Response` B.3
**Owner:** Yasin
**Blocker for:** RFU quotation engine W3

`Req Doc` calls for Booking.com + Expedia + direct contract rates.
`Response` B.3 flags neither Booking.com nor Expedia is currently
B2B-resale-licensed (legal blocker, not technical). GS recommends:
- Phase 1: RateHawk-only (B2B-licensed)
- Phase 1.5: Booking + Expedia once direct B2B agreements signed

**Decision:** _________________________________
**Decided on:** _____________

---

### Q20 — Top-10 airline list for web check-in 🔴

**Source:** `Req Doc` §10 + Section 13 input
**Owner:** Yasin
**Blocker for:** W4 web check-in scope

`Req Doc` §10 names "IndiGo, Emirates, Air India, Vistara and similar".
`Response` B.1 commits 4 airlines for Tier-1 (IndiGo / Air India + AI
Express / Vistara / Emirates). GS proposal: confirm the top-10 list and
accept 4 in P1, 6 more in P1.5.

**Decision:** _________________________________
**Decided on:** _____________

---

### Q21 — Subdomain ownership 🔴

**Source:** `Response` B.9
**Owner:** Travel Stall ops
**Blocker for:** TMC trip microsite

GS proposes `trip-<code>.tmc.travelstall.in`. Confirm Travel Stall owns
`*.tmc.travelstall.in` DNS or adjust pattern (e.g. `*.themodernclassroom.in`).

**Decision:** _________________________________
**Decided on:** _____________

---

### Q24 — Decimal precision for INR amounts 🔴

**Source:** Schema decision
**Owner:** Backend lead (GS)
**Blocker for:** Schema migration

GS proposed `Decimal(18,4)` matching existing CRM convention. Verify
with backend lead before migration. Trade-off: matches existing
patterns vs. INR (rupees + paise) usually only needs `Decimal(15,2)`.

**Decision:** _________________________________
**Decided on:** _____________

---

### Q25 — Sub-brand-level access vs separate tenants 🔴

**Source:** PRD architectural call
**Owner:** Yasin + Backend lead
**Blocker for:** Tenant provisioning (this is irreversible-by-default)

Current PRD assumes 4 sub-brands in 1 tenant with `subBrandAccess[]` per
User. Alternative: 4 separate tenants (one per sub-brand).

Trade-off:
- Single-tenant: shared Contact dedup, easier cross-brand reports, one user
  base with brand-scoped access. Simpler ops.
- Multi-tenant: hard isolation, easier brand-specific data residency,
  easier to spin off a brand later. More auth overhead.

Switching later is expensive (full data migration).

**Decision:** _________________________________
**Decided on:** _____________

---

## Priority tier 3 — MEDIUM · blocks Phase 1 polish / UAT

### Q4 — Payment gateway preference 🔴

**Source:** `Response` A.2
**Owner:** Yasin
**Blocker for:** Accounting integration

Razorpay / PayU / Cashfree. Existing CRM already integrates Stripe + Razorpay.

**Decision:** _________________________________
**Decided on:** _____________

---

### Q5 — Sample CA export from accountant 🔴

**Source:** `Response` A.2
**Owner:** Yasin
**Blocker for:** CA export format

Need an existing Tally / Zoho Books export sample to mirror. Otherwise GS
picks a default and accountant has to map it client-side.

**Decision:** _________________________________
**Decided on:** _____________

---

### Q6 — Data residency confirmation 🔴

**Source:** `Response` A.2
**Owner:** Yasin
**Blocker for:** Hosting setup

GS proposed AWS Mumbai (matches India-resident-data requirement). Need
explicit sign-off (or alternative: Hyderabad, on-prem, etc).

**Decision:** _________________________________
**Decided on:** _____________

---

### Q8 — Excel Software for Travel — integration mode 🔴

**Source:** `Response` A.7 Q2
**Owner:** Yasin
**Blocker for:** Light accounting wire-in

API or file-import only? Share integration docs.

**Decision:** _________________________________
**Decided on:** _____________

---

### Q15 — Named UAT lead + 3 test users per brand 🔴

**Source:** `Response` A.7 Q12
**Owner:** Yasin
**Blocker for:** W6 UAT

Need: 1 UAT lead with sign-off authority + 3 test users per brand
(operator / advisor / parent or pilgrim).

**Decision:** _________________________________
**Decided on:** _____________

---

### Q23 — Premium support tier (90-day hypercare) 🔴

**Source:** `Response` B.12
**Owner:** Yasin
**Blocker for:** Hypercare scope

GS recommends Premium (24×7 critical + phone hotline) for first 90 days
post-launch. Alternative: Standard (business-hours email + chat).

**Decision:** _________________________________
**Decided on:** _____________

---

## Priority tier 4 — CONFLICTS · must resolve to avoid scope creep

These are cross-document conflicts where two source docs disagree.

### Q16 — RFU admin-editable scoring 🔴

**Source:** `Req Doc` §6; `RFU CRM` §1; `Response` A.6
**Owner:** Yasin
**Blocker for:** Diagnostic builder Phase 1

- `RFU CRM` brief says "Editable scoring logic from admin panel"
- `TMC` spec says "non-technical staff should not edit scoring in phase one"
- `Response` A.6 recommends middle ground: view-only P1, edit-with-audit
  trail P1.5

**Options:**
- (a) View-only P1, edit P1.5 (GS proposal)
- (b) Edit in P1, accept audit-log + 2-eye review safeguard
- (c) Read-only P1 + P1.5 (no edit ever — admin contacts GS for changes)

**Decision:** _________________________________
**Decided on:** _____________

---

### Q17 — Travel Stall in/out of Phase 1 🔴

**Source:** `Req Doc` §1 vs `Travelstall CRM` whole file
**Owner:** Yasin
**Blocker for:** Phase 1 scope freeze

`Req Doc` §1 says Travel Stall is out of Phase 1. The full `Travelstall - CRM
development.pdf` describes complete requirements as if in-scope. Confirm
Travel Stall is Phase 2 (not slipping into Phase 1 scope creep).

**Decision:** _________________________________
**Decided on:** _____________

---

### Q18 — Visa Sure in/out of Phase 1 🔴

**Source:** `Req Doc` §1 vs `Visa Sure CRM`
**Owner:** Yasin
**Blocker for:** Phase 1 scope freeze

Same shape as Q17 — `Req Doc` says out of Phase 1, full requirements spec
exists. Confirm Phase 3.

**Decision:** _________________________________
**Decided on:** _____________

---

## Summary checklist

Track per-question status here for at-a-glance progress.

| # | Tier | Question | Status | Decided on |
|---|---|---|---|---|
| Q1 | CRITICAL | Section 13 packet | 🔴 | — |
| Q3 | CRITICAL | DigiLocker creds | 🔴 | — |
| Q7 | CRITICAL | SSO provider | 🔴 | — |
| Q9 | CRITICAL | WhatsApp numbers | 🔴 | — |
| Q10 | CRITICAL | Pipeline labels | 🔴 | — |
| Q13 | CRITICAL | Diagnostic length | 🔴 | — |
| Q14 | CRITICAL | Retention durations | 🔴 | — |
| Q22 | CRITICAL | Brand assets | 🔴 | — |
| Q2 | HIGH | Aadhaar consent copy | 🔴 | — |
| Q11 | HIGH | LLM defaults | 🔴 | — |
| Q12 | HIGH | KPI periods | 🔴 | — |
| Q19 | HIGH | Hotel comparator scope | 🔴 | — |
| Q20 | HIGH | Top-10 airlines | 🔴 | — |
| Q21 | HIGH | Subdomain ownership | 🔴 | — |
| Q24 | HIGH | Decimal precision | 🔴 | — |
| Q25 | HIGH | Tenancy model | 🔴 | — |
| Q4 | MEDIUM | Payment gateway | 🔴 | — |
| Q5 | MEDIUM | CA export sample | 🔴 | — |
| Q6 | MEDIUM | Data residency | 🔴 | — |
| Q8 | MEDIUM | Excel SW integration | 🔴 | — |
| Q15 | MEDIUM | UAT users | 🔴 | — |
| Q23 | MEDIUM | Premium support tier | 🔴 | — |
| Q16 | CONFLICT | RFU editable scoring | 🔴 | — |
| Q17 | CONFLICT | Travel Stall scope | 🔴 | — |
| Q18 | CONFLICT | Visa Sure scope | 🔴 | — |

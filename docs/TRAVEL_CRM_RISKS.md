# Travel CRM — Risk Register

Companion to [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md). Captures the major risks
surfaced during PRD synthesis (from 19 client docs in `travel-crm/`) and the
GlobusSoft response. Each risk lists likelihood, impact, current mitigation,
and the owner who can move it.

**Levels:**
- **Likelihood:** High (will happen unless acted on) · Medium (could happen) · Low
- **Impact:** Critical (kills ship date or product) · High (multi-week delay) · Medium (rework + flake) · Low

**Status legend:** 🟢 Mitigated · 🟡 Mitigation in progress · 🔴 Open · ⚪ Accepted

---

## R1 — Section 13 input packet not delivered 🔴

**Likelihood:** High · **Impact:** Critical · **Source:** `Response` Part D; `Yasin clarifications` §3

The 17-item Section 13 packet (TMC school DB, diagnostic Qs + scoring,
RFU product ladder + cost master, markup/GST rules, airline portal creds,
RFU website fields, Workspace admin, WhatsApp numbers, staff list, branding,
templates, retention durations, reminder schedules, TMC payment/rooming
logic, KPI definitions, LLM keys, manager users) is the gating dependency
for Day 0.

**Why this matters:** The 6-week / 42-day contract clock starts at Day 0.
Every day the packet is late is a day off the back of UAT, hypercare, or
both. There is no slack in the timeline (see R2).

**Current mitigation:** Q1 in [open questions](TRAVEL_CRM_OPEN_QUESTIONS.md).
GS-proposed defaults exist for ~9 of the 17 items (LLM routing, retention
windows, pipeline labels, payment gateway proposal); if Yasin agrees to
accept defaults for those, the remaining 8 items shrink the blocker to a
~3-day list.

**Trigger to escalate:** Section 13 still incomplete 5 working days after
contract signature.

**Owner:** Yasin (Travel Stall)

---

## R2 — 6-week timeline is aggressive 🔴

**Likelihood:** High · **Impact:** Critical · **Source:** `Response` A.1; PRD §10

Phase 1 commits TMC + RFU MVP in 42 days for ₹2,50,000 across 2 milestones.
Internal estimate: ~87 engineer-days of work distributed across 3 parallel
workstreams (diagnostic engine, itinerary + booking, microsite + check-in).
That's roughly 14.5 engineer-days per workstream per week — feasible only
if all 3 streams move in parallel with zero blockers and the team has 3
focused engineers.

**Why this matters:** Slack = 0. Any single risk firing (R1 packet delay,
R3 Chrome extension scope creep, R4 hotel comparator scope drift, R5
DigiLocker delay, R6 SSO surprise) eats directly into the launch window.

**Current mitigation:**
- 70% reuse of existing CRM modules (Contact / Deal / Pipeline / Quote / Invoice
  / Sequence / Email / WhatsApp / Audit / PDF renderer / field encryption /
  dedup / landing-page renderer) per PRD §11. Without that reuse, the
  estimate would be ~150 engineer-days.
- Phase 1 limited to TMC + RFU (Travel Stall = Phase 2, Visa Sure = Phase 3).
- 3 parallel workstreams (vs serial) is the design.

**Trigger to escalate:** Week-2 milestone slips by >2 days. At that point
re-scope to TMC-only-P1 + RFU-P1.5.

**Owner:** GS engineering lead + Yasin (scope adjustment authority)

---

## R3 — Chrome extension auto-update outside the Web Store 🔴

**Likelihood:** Medium · **Impact:** High · **Source:** `Response` B.1

The web check-in plugin (`flight-plugin/` at repo root) ships outside the
Chrome Web Store to bypass the 1-2 week review cycle. That means:
- No auto-update infrastructure from Google. GS must run its own update
  endpoint (`updates.xml` + signed CRX hosting).
- Users may need to whitelist developer-mode extensions (corporate IT
  could block this for some TMC schools).
- Browser-side `chrome.runtime.requestUpdateCheck()` only works for Web
  Store extensions; self-hosted needs manual update checks.

**Why this matters:** Every airline portal DOM change requires a coordinated
extension push. Without a smooth auto-update path, end-users get stuck on
old versions that no longer work.

**Current mitigation:** GS commits to update endpoint + signing + per-airline
adapter test suite. Recommended P1.5: graceful fallback when extension is
out-of-date (route user to manual web check-in with copy-pasteable PNR).

**Trigger to escalate:** First airline DOM change after launch — verify the
update channel actually reaches users within 24h. If >50% of installs are
still on old version after 72h, accept the Web Store review delay and ship
through it for subsequent updates.

**Owner:** GS engineering + Travel Stall IT (for school whitelist liaison)

---

## R4 — Hotel rate comparator scope drift (Booking.com / Expedia not B2B-licensed) 🔴

**Likelihood:** High · **Impact:** Medium · **Source:** `Req Doc` §9 vs `Response` B.3

`Req Doc` §9 names "Hotel rate comparator across Booking.com, Expedia and
direct contract rates" as a Phase 1 requirement. `Response` B.3 flags
neither Booking.com nor Expedia is currently B2B-resale-licensed —
scraping them is a legal blocker, and direct API access requires a B2B
commercial agreement that doesn't exist.

GS-proposed adjustment: RateHawk-only for P1 (B2B-licensed), Booking +
Expedia P1.5 after Travel Stall signs direct B2B agreements.

**Why this matters:** If Yasin insists on Booking + Expedia in P1 the only
options are (a) scraping (legal risk + brittle) or (b) delay until B2B
agreements signed (multi-month). Both jeopardize the 6-week launch.

**Current mitigation:** Q19 in [open questions](TRAVEL_CRM_OPEN_QUESTIONS.md).
GS recommends RateHawk-only P1 + commits to Booking/Expedia integration
within 30 days of B2B agreement signature.

**Trigger to escalate:** Yasin pushes back on RateHawk-only.

**Owner:** Yasin

---

## R5 — DigiLocker partner credentials may not exist 🔴

**Likelihood:** Medium · **Impact:** High · **Source:** `Response` A.2; B.10

Aadhaar OCR for TMC parent KYC + RFU pilgrim KYC requires DigiLocker
partner integration. If Travel Stall does not already hold partner creds,
GS initiates the NeGD application — review cycle is 3-6 weeks (uncontrolled
external dependency).

**Why this matters:** Without DigiLocker, the only legal Aadhaar option is
offline KYC (XML upload by user). Direct OCR is not recommended (Aadhaar
Act §29 makes storage of Aadhaar number a strict-liability offense
without proper consent + retention controls).

**Current mitigation:** Q3 in [open questions](TRAVEL_CRM_OPEN_QUESTIONS.md).
- If creds exist → land DigiLocker in P1
- If not → ship offline-KYC fallback only in P1; DigiLocker arrives P1.5
- Aadhaar consent legal copy (Q2) drafted by GS in parallel

**Trigger to escalate:** No clear answer on cred existence by Day 0.

**Owner:** Yasin / Travel Stall counsel

---

## R6 — Sub-brand single-tenant vs multi-tenant decision is irreversible 🔴

**Likelihood:** Low (won't change unless we decide it wrong) · **Impact:** High · **Source:** PRD §1 + §11

Current PRD assumes 4 sub-brands in 1 tenant with `subBrandAccess[]` per
User. Alternative: 4 separate tenants (one per sub-brand).

**Why this matters:** Switching later means a full data migration:
- Single → multi: split Contact / Deal / Activity / Invoice / Payment
  rows across 4 tenants while preserving cross-brand relationships
- Multi → single: merge 4 tenants' rows, resolve User-id collisions,
  re-key all references

Either direction is a 1-2 week migration project + downtime.

**Current mitigation:** Q25 in [open questions](TRAVEL_CRM_OPEN_QUESTIONS.md).
Single-tenant is the GS recommendation (simpler ops, shared Contact dedup,
easier cross-brand reports). Multi-tenant is recommended only if Yasin
plans to spin off a brand to a separate legal entity within 12-18 months.

**Trigger to escalate:** Decision not made by W1.

**Owner:** Yasin + Backend lead

---

## R7 — LLM cost + observability without a routing layer 🟡

**Likelihood:** Medium · **Impact:** Medium · **Source:** `Response` B.7

PRD §9.1 specifies per-task LLM routing (Perplexity for diagnostic
interpretation, Gemini 2.5 for itinerary draft, Gemini Live for AI
qualification calls, Gemini Vision for OCR fallback, Gemini 2.5 for
sentiment). Without a thin router layer, every code site picks its own
model + key + retry semantics, and per-task cost attribution becomes
guesswork.

**Why this matters:**
- TMC + RFU together will likely generate 500-2000 LLM calls/day at
  steady state. At unmonitored costs that's a budget surprise.
- Switching a model later (e.g. Gemini 3.0 ships, Perplexity rate hike)
  requires touching every call site.

**Current mitigation:** PRD §9 calls out a `backend/lib/llmRouter.js`
module with per-task-class admin config + audit trail (token in, token
out, ms latency, USD cost). Decision still open (Q11) on default model
per task class.

**Trigger to escalate:** Daily LLM cost crosses ₹500 on demo without
operator alert.

**Owner:** GS engineering lead

---

## R8 — Aadhaar handling legal exposure 🟡

**Likelihood:** Low · **Impact:** Critical · **Source:** `Response` B.10; Aadhaar Act §29

Direct OCR of Aadhaar card images stores the Aadhaar number, which under
the Aadhaar Act §29 is strict-liability without registered partner status
+ explicit consent + retention controls. The penalty is criminal liability
for the entity *and* the individuals processing it.

**Why this matters:** Even with consent text in place, processing Aadhaar
numbers without partner registration is illegal. A single misconfigured
test row in production = legal exposure.

**Current mitigation:**
- DigiLocker partner integration (R5) is the ONLY clean path.
- Offline KYC (XML upload) is acceptable.
- Direct OCR of Aadhaar images is explicitly **disallowed** in the PRD.
- `lib/fieldEncryption.js` AES-256-GCM is already in place for any
  Aadhaar token storage.
- Audit log retention (Q14) needs to align with Aadhaar-specific
  retention rules.

**Trigger to escalate:** Any developer pushes code that ingests Aadhaar
number from non-DigiLocker source.

**Owner:** Travel Stall counsel + GS engineering

---

## R9 — Multi-WABA WhatsApp provisioning timeline 🔴

**Likelihood:** Medium · **Impact:** Medium · **Source:** `Response` A.7 Q3; B.8

3 separate WhatsApp Business Accounts (TMC / RFU / ops-shared) require:
- 3 verified business phone numbers (Travel Stall procures)
- 3 Meta Business Manager verifications (5-7 business days each)
- 3 Wati BSP provisioning cycles (Wati ops typically 2-3 days)

If procurement of any number slips, the dependent brand's WhatsApp
templates can't be tested → blocks UAT for that brand.

**Why this matters:** WhatsApp is the primary customer channel per the
PRD. Without provisioning, TMC parents and RFU pilgrims have no
communication channel beyond email.

**Current mitigation:** Q9 in [open questions](TRAVEL_CRM_OPEN_QUESTIONS.md).
Suggest Yasin starts the 3-number procurement on contract day, not Day 0.

**Trigger to escalate:** All 3 numbers not Meta-verified by W3.

**Owner:** Yasin

---

## R10 — Scope creep risk on Travel Stall + Visa Sure 🔴

**Likelihood:** Medium · **Impact:** Medium · **Source:** `Req Doc` §1 vs `Travelstall CRM` + `Visa Sure CRM`

Both Travel Stall and Visa Sure have full requirement specs in the source
docs but `Req Doc` §1 explicitly puts them out of Phase 1.

**Why this matters:** Mid-build, it's common for the customer to "just add
this one Travel Stall feature." Each addition cascades — Travel Stall and
Visa Sure share the diagnostic engine + microsite + supplier integrations
with TMC + RFU, so any extension touches the shared modules and adds risk
to the in-flight Phase 1 ship.

**Current mitigation:**
- Q17 and Q18 in [open questions](TRAVEL_CRM_OPEN_QUESTIONS.md) — explicit
  scope freeze for Phase 1.
- PRD §10 phasing committed in writing: TMC + RFU P1; Travel Stall P2; Visa
  Sure P3.
- All Travel Stall + Visa Sure work goes to a change-order process (P1.5
  or later) — no in-flight Phase 1 additions.

**Trigger to escalate:** First "could we add X from Travel Stall to Phase 1"
request. Default response: "yes, in a P1.5 change order; not in P1."

**Owner:** GS engineering lead + Yasin (jointly enforce)

---

## Summary table

| # | Risk | Likelihood | Impact | Status | Owner |
|---|---|---|---|---|---|
| R1 | Section 13 packet | High | Critical | 🔴 | Yasin |
| R2 | 6-week timeline | High | Critical | 🔴 | GS + Yasin |
| R3 | Chrome extension auto-update | Medium | High | 🔴 | GS + Travel Stall IT |
| R4 | Hotel comparator scope drift | High | Medium | 🔴 | Yasin |
| R5 | DigiLocker credentials | Medium | High | 🔴 | Yasin |
| R6 | Tenancy model irreversibility | Low | High | 🔴 | Yasin + Backend lead |
| R7 | LLM cost + observability | Medium | Medium | 🟡 | GS |
| R8 | Aadhaar legal exposure | Low | Critical | 🟡 | Counsel + GS |
| R9 | Multi-WABA timeline | Medium | Medium | 🔴 | Yasin |
| R10 | Travel Stall + Visa Sure creep | Medium | Medium | 🔴 | GS + Yasin |

---

## Review cadence

This document should be reviewed:
- Weekly during Phase 1 build
- Daily during the final week before UAT
- Before any milestone payment release

When a risk's mitigation lands, move it to 🟢 with a one-line note (date +
commit / decision reference). When a new risk surfaces during build, add
it here with the same shape.

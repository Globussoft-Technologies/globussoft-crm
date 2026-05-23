# Callified.ai AI Qualification Calling — Product Requirements

**Status:** SPEC — cred-blocked on Q1 ("Section 13 packet" — Callified.ai
handover from Yasin: API docs + production keys + sub-brand persona/script
sign-off) per [TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md).
GS response Section B.5 (2026-05-15) confirms ₹5/min on Exotel, <500ms
mid-call language-switch target, and ad/marketing-only gating in Phase 1.

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §6
(Communications) line 65 (`AI qualification call (Eng/Hin/Urdu …)`) +
§roadmap W2 (`Both diagnostics live; AI calling with summary attached`).

**Portal matrix references:** rows **O17** (AI qualification calling
Eng/Hin/Urdu with mid-call switch) + **O18** (call recording / transcription
/ summary attached to lead) in
[TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md](TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md) —
both ⏸️ BLOCKED on Q1.

**Engineering cluster:** **C6** in
[MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md) — ~2-3 engineer-days
post-handover (stub-mode client first, real-mode swap on cred-drop).

**Audience:** Yasin (Q1 Section 13 packet delivery owner — Callified.ai is
his sister Globussoft product), GS engineering, Travel Stall ops + counsel
(consent disclosure copy review).

---

## 1. Background

AI qualification calling is the **automated first-touch** for ad/marketing
leads across TMC and RFU. Today every customer-facing CRM feature dispatches
to an AI-calling stub at `scripts/sandbox/callified-mock.js` (the portal
matrix O17 evidence row); production wiring waits on Yasin's Section 13
handover of Callified.ai's API docs + production credentials + the
sub-brand persona/script sign-off.

### 1.1 Source attribution + architectural shape

The AI-calling requirement originates from **a single bullet in Yasin's
clarifications email** (`travel-crm/Understanding and clarifications -
Yasin.pdf`, 2026-05-13 18:16 IST), under "Additional clarifications we need
from you":

> **AI qualification calling:** per-minute cost on Exotel, language-switch
> latency, and confirmation that AI calling will be gated to ad/marketing
> leads only in phase one.

That bullet asks 3 distinct questions. GS's formal reply landed in
`travel-crm/GlobusSoft_Response_15May2026.pdf` Section **B.5**:

| Yasin asked | GS answered |
|---|---|
| Per-minute cost on Exotel | ₹5/min outbound; inbound on virtual number is free. Billed pass-through, zero GS margin. |
| Mid-call language-switch latency | Target <500ms; current 600–800ms on Groq + Hagen pipeline. Tuning in W2. |
| Ad/marketing-only gating in P1 | **Confirmed.** Rule at ingestion: `source ∈ {Meta/Google/LinkedIn/YouTube Ads, paid UTM} → Callified.ai`. Organic, referral, walk-in → advisor directly. Configurable in admin panel. |

GS also added a 4th item Yasin did not explicitly ask about: a
**TRAI-mandatory pre-call disclosure** in Eng/Hin/Urdu (*"This call is from
RFU/TMC and may be recorded for service quality"*). This is non-negotiable
per TRAI; counsel review on exact wording remains open (see DC-5 below).

### 1.2 Direction of integration — REVERSE of the partner-API flow

Callified.ai is one of two sister Globussoft products already integrated as
a **partner API consumer** (per CLAUDE.md `External Partner API` section).
Today's flow: Callified.ai POSTs to `/api/v1/external/calls` and
`/api/v1/external/leads` (live at
[`backend/routes/external.js:185-371`](../backend/routes/external.js)).
Callified is the caller; CRM is the receiver.

**This PRD covers the REVERSE flow:** the CRM is the caller; Callified is
the executor.

```
TODAY  (✅ SHIPPED)                            PRD SCOPE  (🔴 NOT-STARTED)
                                                ↓
Callified.ai ──POST /v1/external/calls──▶ CRM   CRM ──services/callifiedClient──▶ Callified.ai
Callified.ai ──POST /v1/external/leads──▶ CRM   CRM ◀──POST /v1/external/calls/:sid/summary── Callified.ai
                                                ↓
                                          (CRM triggers the call;
                                           Callified handles voice;
                                           summary attached to lead)
```

The inbound half stays as-is — POSTed CallLog rows + lead-creation. The new
outbound half is the **trigger** (CRM → Callified) + the new **summary
webhook** (Callified → CRM with a richer payload than today's `/calls`).

**Source-of-truth chain:**
```
Yasin's email (2026-05-13)              ← 3 questions on cost / latency / gating
  └─ GS B.5 (2026-05-15)                 ← answered all 3 + raised TRAI disclosure
       └─ Portal matrix O17 + O18         ← ⏸️ BLOCKED on Q1
            └─ Cluster C6 (MANUAL_BACKLOG) ← ~2-3 engineer-days post-handover
                 └─ this PRD (live)         ← formal spec; ships behind Q1 cred drop
                      └─ stub-mode client (TBD) + cron dispatcher (TBD)
                           └─ Q1 Callified handover ← outstanding (§5 below)
```

---

## 2. Use cases — what triggers the AI

Five distinct trigger points. All five funnel into the same
`callifiedClient.triggerCall(...)` → Callified handles the voice →
`/calls/:sid/summary` webhook fires back.

### 2.1 Auto-trigger on ad/marketing lead arrival (primary path)

| Lead source | Today | After Q1 ships |
|---|---|---|
| `meta-ad` / `google-ad` / `youtube-ad` / `linkedin-ad` / `whatsapp-ad` / `?utm_medium=paid` | New `Contact` row + advisor task in queue | AI call triggered within 5 min of arrival; AI qualifies in Eng/Hin/Urdu; summary attached to Contact; advisor sees brief BEFORE callback |
| `referral` / `website-form` / `inbound-whatsapp` / `walk-in` / `existing-customer` | Same advisor task | **Unchanged** — gated OUT of AI calling in Phase 1 per Yasin's clarification |

Phase 2 may expand the source whitelist; Phase 1 is reactive + ad-gated.

### 2.2 Operator-triggered AI call (secondary path)

Advisor manually fires `POST /api/travel/callified/initiate?contactId=:id`
for an inbound enquiry the parent hasn't been reachable on. Useful when the
parent's phone is busy / not picking up — AI tries 2-3 times before
flipping to human queue. Same gating + persona + recording infrastructure
applies.

### 2.3 Diagnostic form-vs-call live-mode (R-cluster R6 / O19)

The form-vs-call comparison endpoint at
[`backend/routes/travel_diagnostics.js:519-641`](../backend/routes/travel_diagnostics.js)
(commit `4a7c623`) currently reads a hand-typed `callTranscript` body
field. Post Q1 cred-drop, the same endpoint reads the real Callified
transcript via `getCallSummary(sid).transcript` — same comparison logic,
real source of truth. This is cluster C6's acceptance criterion #2.

### 2.4 Outcome paths

Every AI call ends in one of four states. The outcome drives the next-step
routing:

| Outcome | `aiCallStatus` | Next step |
|---|---|---|
| Qualified (intent + budget + timeline confirmed) | `completed` | Advisor sees summary + score; manual callback within SLA |
| Disqualified (out-of-scope / non-traveler / spam) | `completed` (low score) | Polite decline; lead marked `Junk` if score < threshold |
| Callback requested (parent busy mid-call) | `completed` (with callback flag) | Advisor schedules at requested time |
| AI failed / parent refused AI / TRAI opt-out | `refused` / `failed` | High-priority human queue with reason logged |

### 2.5 Opt-out — parent says "no AI"

DPDP §11 + TRAI: every recipient can refuse AI engagement. The AI ends
politely + the contact is permanently flagged `aiCallOptOut=true` (no
further AI attempts on the same number across any sub-brand). Same column
also gates the existing WhatsApp opt-out scheme — both channels share the
opt-out flag.

---

## 3. Functional requirements

| FR-ID | Requirement | Status |
|---|---|---|
| FR-1 | NEW `backend/services/callifiedClient.js` — mirrors the partner-API auth shape in `backend/middleware/externalAuth.js`. Stub-mode-ready (`// STUB: Callified integration pending Q1 Section 13 packet handover`). | 🔴 NOT-STARTED |
| FR-2 | Client methods: `triggerCall({contactId, leadId, language, persona, contextSummary})` → returns `{callSessionId, status}`; `getCallSummary(callSessionId)` → returns `{transcript, summary, qualificationScore, recordingUrl, durationSeconds, languagesUsed[]}`. | 🔴 NOT-STARTED |
| FR-3 | NEW `backend/cron/aiQualificationDispatcher.js` — runs every 5 min; queries `Contact WHERE source IN <whitelist> AND aiCallStatus IS NULL AND aiCallOptOut = false`; rate-limited (max 1 AI call per Contact, ever; configurable retries). | 🔴 NOT-STARTED |
| FR-4 | Additive nullable schema columns on `Contact`: `aiCallStatus String?` (pending / in-progress / completed / failed / refused), `aiCallSessionId String?`, `aiCallQualificationScore Decimal?`, `aiCallSummary String? @db.Text`, `aiCallOptOut Boolean @default(false)`, `aiCallLanguagesUsed Json?`. Additive nullable; no bless marker needed. | 🔴 NOT-STARTED |
| FR-5 | NEW webhook endpoint `POST /api/v1/external/calls/:sessionId/summary` — extends [`backend/routes/external.js`](../backend/routes/external.js) per the CLAUDE.md *"Callified.ai POSTs to /api/v1/external/calls"* pattern. Idempotent on `sessionId`. Receives the summary, updates the Contact, fires advisor notification. Auth via existing `X-API-Key`. | 🔴 NOT-STARTED |
| FR-6 | Language support — Hindi / English / Urdu with mid-call switch. Per GS B.5: <500ms target switch latency (current 600-800ms on Groq+Hagen; tuning in W2). Persisted as `aiCallLanguagesUsed Json?` array. | 🔴 NOT-STARTED |
| FR-7 | Cost cap — per-tenant monthly budget (default $100 / ₹8,000 ≈ 1,600 minutes at ₹5/min) + per-call hard ceiling (default 90s). When monthly cap exhausted, dispatcher logs `cap-exceeded` + ADMIN notification + AI calling paused until next month. | 🔴 NOT-STARTED |
| FR-8 | Recording retention — 90 days default; configurable per tenant per DPDP. Retention cron (`backend/cron/retentionEngine.js`) already covers per-type retention windows; add `call-recording` enum + per-tenant override. | 🔴 NOT-STARTED |
| FR-9 | Advisor briefing UI — extends [`frontend/src/pages/travel/LeadDetail.jsx`](../frontend/src/pages/travel/LeadDetail.jsx) (commit `a84289e`) with new "AI Call Summary" panel: transcript snippet + qualification score (0-100) + recommended action chip + recording playback + languages-used badges. | 🔴 NOT-STARTED |
| FR-10 | TRAI pre-call disclosure — non-negotiable per GS B.5. AI plays a 5-second disclosure in Eng/Hin/Urdu at call start: *"This call is from <SubBrand> and may be recorded for service quality."* Wording counsel-reviewed (DC-5). |  🔴 NOT-STARTED |
| FR-11 | Sub-brand routing — TMC / RFU / Travel Stall / Visa Sure each map to their own Callified persona + script. Resolved via [`backend/lib/subBrandConfig.js`](../backend/lib/subBrandConfig.js) (commit `621aab7`) — same helper that drives WhatsApp WABA selection. | 🔴 NOT-STARTED |
| FR-12 | Audit log — `writeAudit("callified.call.triggered" / ".summary.received" / ".cap.exceeded" / ".opt.out", {...})` for every state transition. Mirrors the partner-API audit emission shape in `backend/lib/audit.js`. | 🔴 NOT-STARTED |

---

## 4. Non-functional requirements

| NFR | Target |
|---|---|
| **Trigger latency** (lead-arrival → AI-call-fired) | < 5 min p95 (cron tick every 5 min; first tick after arrival picks it up) |
| **Per-call duration** | < 90s p95 (qualifying calls are short; budget enforced at call setup) |
| **Mid-call language-switch latency** | < 500ms target per GS B.5 (current 600-800ms; W2 tuning) |
| **Per-minute cost** | ₹5/min Exotel pass-through (GS B.5); zero GS margin |
| **Trigger throughput** | < 20 concurrent calls per tenant (configurable; protects Exotel rate limits) |
| **Webhook ingest latency** | < 2s p95 from Callified summary POST to Contact row update |
| **Recording security** | Encrypted at rest on Callified storage; CRM stores URL only; advisor-only access via signed time-limited URL |
| **Compliance** | TRAI pre-call disclosure mandatory; DPDP §11 opt-out honored within 1 minute; recording retention per FR-8 |
| **TCPA / international** | US/UK lead numbers excluded from AI calling in Phase 1 (DC-6); explicit allowlist in Phase 2 after counsel review |

---

## 5. Hand-over requirements + decisions needed

This is the section that unblocks every use case in §2.

### 5.1 Q1 — Yasin's Section 13 packet for Callified.ai

The single multi-vendor packet Yasin committed to in the 2026-05-13 email
covers Callified.ai + AdsGPT + Google Workspace OAuth. The Callified slice:

| Artifact | What it is | Where it lands |
|---|---|---|
| **API base URL + auth scheme** | Callified.ai's REST endpoint for `triggerCall` + the auth header shape (likely `X-API-Key: cf_…` mirroring our `glbs_…` partner-key pattern, but TBD). | `CALLIFIED_API_BASE_URL` + `CALLIFIED_API_KEY` env vars |
| **Per-tenant API key** | One key per Travel CRM tenant — Callified scopes billing + recordings per key. | Encrypted in `WhatsAppConfig`-style per-tenant `CallifiedConfig` row (new model) |
| **Persona library** | Voice persona + initial script per sub-brand (TMC school-trip vs RFU Umrah vs Travel Stall holiday vs Visa Sure visa). | `subBrandConfig.callified.personaId` per sub-brand |
| **Webhook secret** | HMAC secret for `/api/v1/external/calls/:sid/summary` POSTs from Callified back. | `CALLIFIED_WEBHOOK_SECRET` env var |
| **Recording URL signing key** | If recordings are signed URLs (TBD per Callified's product spec). | `CALLIFIED_RECORDING_SIGNING_KEY` env var |
| **API docs** | OpenAPI / Swagger / written spec — endpoints, payload shapes, error codes, rate limits. | Read by GS engineering; no env footprint |

### 5.2 Seven product decisions needed (DC-1 … DC-7)

#### DC-1: Cost cap default per tenant

**Question:** what's the per-tenant monthly budget default? Per-call hard ceiling?

**GS recommendation:** **monthly cap $100 (₹8,000 ≈ 1,600 min at ₹5/min);
per-call hard ceiling 90s wall-clock**. Rationale: 1,600 min ÷ 90 s/call ≈
~1,000 calls/month per tenant, well above expected ad-lead volume for both
TMC + RFU launch. A single runaway 30-min call (Callified bug or
parent-keeps-talking) capped at 90s prevents budget drain. Both values
admin-overridable per tenant via Settings.

#### DC-2: Lead-source whitelist for ad/marketing gating

**Question:** Yasin's email confirms "ad/marketing leads only in phase
one"; what's the exact source whitelist?

**GS recommendation:** **`source IN ('meta-ad', 'google-ad',
'youtube-ad', 'linkedin-ad', 'whatsapp-ad') OR utm_medium IN ('cpc',
'paid', 'paid_social', 'cpm')`**. Referral / website-form (organic) /
inbound-whatsapp / walk-in / existing-customer / portal-direct stay
human-only. Configurable in admin panel per GS B.5 ("Configurable in admin
panel"). UI surface: extend
[`frontend/src/pages/Channels.jsx`](../frontend/src/pages/Channels.jsx) or
add a new `AiCallingSettings.jsx`.

#### DC-3: AI persona + script per sub-brand

**Question:** TMC / RFU / Travel Stall / Visa Sure — each sub-brand needs
its own persona + qualification script. Who authors?

**GS recommendation:** **Yasin's content team drafts** the script per
sub-brand (1-2 pages each: greeting → qualification questions → soft
disqualification → handoff); **GS proposes a starter template** based on
the existing diagnostic question banks (TMC 7-question / RFU 15-question)
so Yasin reviews rather than writes-from-blank. Sign-off counts as part
of Q1 cred-drop. Loaded into Callified persona library; CRM references via
`subBrandConfig.callified.personaId`.

#### DC-4: Opt-out wording (parent says "no AI")

**Question:** what does the AI say when the parent declines AI engagement?

**GS recommendation:** **"Understood. I'll have a senior travel consultant
call you back within the next hour. Thank you for your time."** in
Eng/Hin/Urdu. Triggers `aiCallStatus=refused` + high-priority human queue.
Counsel review on exact wording (similar to the Aadhaar consent draft at
`docs/TRAVEL_AADHAAR_CONSENT_DRAFT.md`, commit `7d162cd`).

#### DC-5: TRAI pre-call recording disclosure

**Question:** exact disclosure wording at call start?

**GS recommendation (per B.5):** **"This call is from <SubBrand> and may
be recorded for service quality."** in Eng/Hin/Urdu. Counsel review on
whether "for service quality" suffices or whether explicit
"AI-conversational-agent" disclosure is also required under emerging
DPDP / DoT-AI norms. Currently TRAI requires only the recording
disclosure; AI-agent disclosure is not yet mandated (2026-Q2 expected
amendment). GS recommends ship-with-recording-only-disclosure, add
AI-agent disclosure in a follow-up if mandated.

#### DC-6: Failure-path operator surface

**Question:** when Callified is down / call times out / persistent failure
class, what does the operator see?

**GS recommendation:** **Dashboard tile** on `Dashboard.jsx` ("AI calling:
N pending, M failed in last hour"); **Slack/email alert** to ADMIN when
failure rate > 20% over 1-hour window. No per-call SMS / WhatsApp ping to
ops (would create noise). V1 dashboard-only; V2 reconsider escalation
cadence based on observed failure-class distribution.

#### DC-7: Per-tenant disable toggle

**Question:** can ADMIN globally pause AI calling for their tenant via
admin UI?

**GS recommendation:** **Yes — per-tenant `aiCallingEnabled Boolean
@default(false)` on Tenant**; default-disabled for first 30 days
post-launch (allowlist-by-default). Single toggle in admin Settings
disables the dispatcher cron + queues ad-lead arrivals for human queue
instead. Surfaces "AI calling disabled" badge on LeadDetail.jsx for
operator awareness.

### 5.3 International / TCPA exclusion (Phase 1 default-off)

Per FR-NFR table: US/UK lead phone numbers excluded from AI calling in
Phase 1 by default. Implementation: dispatcher cron checks
`Contact.phone` country code; non-IN numbers default-skip. Phase 2 lifts
this after counsel review of TCPA / GDPR-equivalent rules per
destination market. **Yasin call:** is there a need for US/UK AI calling
in Phase 1 (Travel Stall international family-holidays)? If yes, raise as
DC-8 in next revision.

---

## 6. Acceptance criteria

The integration is "done" when **all 8 of the following are demonstrable**:

| # | Test | Verifies |
|---|---|---|
| AC-1 | New `Contact` with `source='meta-ad'` arrives via `POST /api/v1/external/leads` → within 5 min the dispatcher cron fires `callifiedClient.triggerCall(...)` → Callified returns `callSessionId` → `Contact.aiCallStatus='in-progress'`. | FR-3 + FR-1 + ad-gating |
| AC-2 | Callified completes call → POSTs to `/api/v1/external/calls/:sid/summary` → `Contact.aiCallStatus='completed'` + summary + score + recordingUrl populated within 60s. | FR-5 |
| AC-3 | `LeadDetail.jsx` for that contact shows the AI Call Summary panel: transcript snippet + score chip + recommended action + recording playback. | FR-9 |
| AC-4 | New `Contact` with `source='website-form'` arrives → dispatcher cron skips it (gating per DC-2); no Callified API call fires; `Contact.aiCallStatus` stays NULL. | FR-3 + DC-2 |
| AC-5 | Tenant monthly cap reached → next trigger logs `cap-exceeded` + ADMIN notification fires + AI calling paused for that tenant until next month. | FR-7 + DC-1 + DC-6 |
| AC-6 | Advisor manually triggers AI call via `POST /api/travel/callified/initiate?contactId=:id` → same trigger + summary flow; same persona + recording disclosure. | §2.2 |
| AC-7 | Parent refuses AI mid-call → Callified posts summary with `outcome='refused'` → `Contact.aiCallOptOut=true` + `aiCallStatus='refused'` + lead moved to high-priority human queue + audit log `callified.opt.out` written. | FR-10 + §2.5 + FR-12 |
| AC-8 | TMC sub-brand contact uses TMC persona; RFU contact uses RFU persona — verified by `subBrandConfig.callified.personaId` resolution. | FR-11 |

GS owns the e2e validation; Yasin (Travel Stall) owns acceptance + content
approval (DC-3 personas).

---

## 7. Out of scope

- **AI-led full-sales / closing** — AI qualifies only; advisor closes. AI
  is never authorised to commit pricing, send contracts, or process
  payments.
- **Phone-tree / IVR replacement** — separate Callified product line; not
  on this PRD.
- **Cold-call outbound campaigns** — Phase 2. Current scope is **reactive**
  (calls triggered by lead arrival, not by operator selecting a list).
- **Multi-party conferences** — V1 is 1:1 AI ↔ parent. AI-to-advisor
  warm-transfer is Phase 2.
- **Phone-number rentals** — uses each tenant's existing Exotel virtual
  number; no new number procurement in scope.
- **SMS / WhatsApp mid-call channel switch** — operator's job post-call;
  this PRD focuses on voice + summary only.
- **Voice-clone / custom-voice training** — uses Callified's default
  Indian-English / Indian-Hindi / Indian-Urdu personas; no custom voice in
  V1.
- **Real-time advisor whisper / listen-in** — Phase 2; V1 is fire-and-summary.

---

## 8. Dependencies + downstream

- **Existing infra (REUSE):**
  - [`backend/routes/external.js`](../backend/routes/external.js) — partner-API
    (Callified already POSTs to `/calls` + `/leads`); webhook-in summary
    endpoint extends this file
  - [`backend/middleware/externalAuth.js`](../backend/middleware/externalAuth.js) —
    X-API-Key auth pattern; reused for FR-5
  - [`backend/routes/voice.js`](../backend/routes/voice.js) +
    [`backend/routes/voice_transcription.js`](../backend/routes/voice_transcription.js) —
    Twilio softphone + transcription; AI calling does NOT route through
    these (Callified uses Exotel) but the `CallLog` model is shared
  - [`backend/lib/subBrandConfig.js`](../backend/lib/subBrandConfig.js)
    (commit `621aab7`) — extended with `callified.personaId` per
    sub-brand
  - [`backend/lib/audit.js`](../backend/lib/audit.js) — `writeAudit(...)`
    for state transitions (FR-12)
  - [`backend/cron/retentionEngine.js`](../backend/cron/retentionEngine.js) —
    extended with `call-recording` retention type (FR-8)

- **Schema** — 6 additive nullable columns on `Contact` (no bless
  marker); 1 new column on `Tenant` (`aiCallingEnabled`); 1 new
  `CallifiedConfig` model (per-tenant API key + monthly cap + persona
  overrides). See FR-4 + DC-7.

- **Sister integrations:**
  - **Form-vs-call compare endpoint** at
    [`routes/travel_diagnostics.js:519-641`](../backend/routes/travel_diagnostics.js)
    (commit `4a7c623`) — currently reads hand-typed `callTranscript`;
    post Q1 reads real Callified transcript via `getCallSummary(sid)`.
    This is cluster C6's AC #2.
  - **WhatsApp opt-out** — shared `aiCallOptOut` flag with WhatsApp
    opt-out semantics (one DPDP §11 refusal blocks both channels).

- **Downstream Q11 (LLM keys)** — AI call summary uses LLM router
  ([`backend/lib/llmRouter.js`](../backend/lib/llmRouter.js), commit
  `583c06b`) for narrative generation. Today the router is stub-mode; on
  Q11 cred-drop, summaries become richer (per GS B.7: "call summary →
  Gemini Flash"). Callified provides the raw transcript; LLM generates the
  human-readable summary + qualification score. **Independent block** —
  AI calling can ship with stub-mode summaries; Q11 enriches.

- **Downstream Q9 (WhatsApp)** — "AI call summary ready" advisor
  notification depends on Q9 WhatsApp for the WA channel. Email fallback
  works meanwhile via existing email engine. **Independent block.**

---

## 9. Open questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | Q1 Section 13 packet ETA from Yasin (Callified.ai handover). | Yasin |
| OQ-2 | DC-1 through DC-7 design calls — see §5.2. Recommend single Yasin-call covering all 7 in one session (~30 min). | Yasin + GS |
| OQ-3 | Call-quality monitoring — should we sample N% of recordings for audio-dropout / transcript-vs-recording-diff QA? V1 trusts Callified's quality; V2 reconsider if observed quality issues surface. | Operations |
| OQ-4 | AI mis-qualification recovery — when AI false-disqualifies a real lead, what's the operator surface? **GS recommendation:** every AI-called lead also surfaces in an admin "AI review queue" auditable for first 30 days; advisor can override `qualificationScore` → re-route to human queue with reason logged. | Yasin (product call) |
| OQ-5 | Outbound caller-ID — tenant's existing Exotel-rented number OR Callified shared pool? **GS recommendation:** tenant's own number (better trust + answer-rate; parent recognises the local number if they've seen ads/WA from it). | Yasin |
| OQ-6 | TCPA / international compliance for US/UK leads (Travel Stall family-holidays). See §5.3. | Counsel |
| OQ-7 | "AI-agent disclosure" beyond TRAI recording disclosure — see DC-5 commentary. Track 2026-Q2 amendment. | Counsel |
| OQ-8 | Per-call hard ceiling lower than 90s? Some qualifying calls genuinely need 2-3 min; 90s feels tight. **Re-revisit post Phase 1 launch with real distribution data.** | GS engineering |

---

## 10. Status snapshot

### 2026-05-24 update #3 — Cap-consumer wrapper series 4/4 complete + CapBanners rule-of-3 retrofit

**Series complete:** the cap-consumer wrapper-route + admin-UI pattern landed across all 4 stubbed services (adsgpt + ratehawk + callified + booking_expedia) in SHA range `850391d` → `93acf61`. End-to-end cap-helper wiring (`TenantSetting` CRUD `1542b8e` + admin UI `0054a03` + `getBudgetCap` helper + 5 live consumers including llmRouter) is operator-reachable per tenant.

**Callified-specific UI shape:** `frontend/src/pages/admin/CallifiedCalls.jsx` at commit `7c7b88b` checks `GET /api/callified/enabled` on mount (DC-7 feature-flag wiring) — when the toggle is OFF, the page renders a full-page disabled state ("AI calling is disabled for this tenant"); when ON, the operator gets the initiate-call form + cap-status pill + stub-mode banner.

**CapBanners extraction (rule-of-3 retrofit):** shared `frontend/src/components/CapBanners.jsx` at commit `93acf61` consolidates the cap-pill / stub-mode banner / cap-exceeded banner across all 4 admin pages — net **−259 LOC** (466 deletions vs 207 insertions). All `data-testid`s preserved (`callified-cap-pill` / `callified-stub-banner` / `callified-cap-exceeded-banner` unchanged). Companion `backend/lib/subBrandResolve.js` extraction at `3236d35`.

### 2026-05-24 update #2 — Operator routes

**Backend wrapper routes shipping THIS TICK (in-flight by sibling agent):** `backend/routes/callified.js` — fourth wrapper in cred-stub series (after AdsGPT + RateHawk + BookingExpedia stubs but third route-wrapper). Routes:
- `POST /calls/initiate` — initiate outbound AI call (ADMIN/MANAGER, audited; cap-exceeded → 402; disabled → 403)
- `GET /calls/:callId/result` — fetch call recording / transcript / summary (read-only)
- `GET /cap-status` — ADMIN-only cap check
- `GET /enabled` — check whether AI calling is enabled for the tenant (DC-7 feature flag check)

**Architectural finding:** callified.js wrapper handles MORE error codes than the AdsGPT/RateHawk siblings (AI_CALLING_BUDGET_EXCEEDED → 402, AI_CALLING_DISABLED → 403 per DC-7 feature flag, plus regular validation). First wrapper to need 2-distinct-error-code handling — if a 3rd wrapper hits the same pattern, candidate for `wrapError(e, errorCodeMap)` helper.

**Sub-brand isolation:** persona resolution per DC-3 reads from `Tenant.subBrandConfigJson` — the wrapper uses `resolveSubBrand(req, supplied)` helper to enforce sub-brand match between caller's API key scope and request body.

**DC-2 lead-source whitelist gate placement:** confirmed at the CALLER layer (workflow rule / auto-dial cron) NOT inside this client — per agent decision in commit `9ec52df`. The wrapper stays source-agnostic.

**Still pending:**
- Real-mode swap (cred-blocked on Q1 Yasin Callified.ai handover)
- Admin UI for /calls/initiate + result viewer (future slice after wrapper lands)
- DC-2 source-whitelist enforcement (lives at caller layer; needs workflow-rule update)
- DC-3 per-sub-brand persona seeding (currently reads from subBrandConfigJson which has no callifiedPersona_<subBrand> rows seeded yet — needs seed-travel.js extension)
- TRAI disclosure copy (DC-5 counsel-batched — pending the single counsel session)

**Path to real-mode:** When Yasin's handover lands, swap the stub body of `initiateCall`/`fetchCallResult` in `services/callifiedClient.js` with real Callified.ai endpoint calls. Wrapper + feature-flag + cap + sub-brand isolation stays unchanged. ~2-3 days post-cred per the CREDS_TRACKER estimate.

### 2026-05-24 update — STUB client shipped + cap wired

**Backend STUB shipped:** `backend/services/callifiedClient.js` at commit `9ec52df`. Mirrors the
canonical STUB pattern (header marker + `// STUB:` warning + canned response shape +
console.log observability + CJS self-mocking seam per the 4-instance pattern logged
to CLAUDE.md cron-learnings tick #99). 10/10 vitest cases pass (exceeded the 5-case
minimum — 90s per-call ceiling, lead-source whitelist gating, per-tenant disable
toggle, persona/script subBrand lookup, and TRAI disclosure metadata each got
dedicated cases).

**Per-tenant cap wired:** Calls `getBudgetCap(tenantId, 'callified')` via the
cross-cutting TenantSetting pattern (helper at `backend/lib/tenantSettings.js`,
operator-writable surface at `/api/tenant-settings` per commit `1542b8e`).
Hard-stops at cap with `CALLIFIED_BUDGET_EXCEEDED`. 80% threshold alert via console.warn.
Admin UI for cap overrides shipping this tick by a sibling agent.

**Decisions implemented:**
- **DC-1** — $100/mo per-tenant cap + 90s per-call ceiling (cap via `getBudgetCap`,
  ceiling enforced inline in `initiateCall`)
- **DC-2** — lead-source whitelist (gate at caller layer, NOT in client — client
  documents this contract in header but doesn't enforce; dispatcher cron will
  filter pre-invocation)
- **DC-3** — persona/script per sub-brand looked up via `Tenant.subBrandConfigJson`
  (consumes the same field shipped at `621aab7`)
- **DC-5** — TRAI disclosure metadata baked into stub response shape (single
  counsel session covers all 4 sub-brands)
- **DC-7** — per-tenant disable toggle via `TenantSetting{ key: 'callifiedEnabled' }`

**Cred chase status:** docs/CREDS_TRACKER.md Cat 1 Q1 row, cluster C6 (Yasin
Callified.ai handover packet — Section 13 multi-vendor bundle). Stub is the
swap-point; ~1 day to real-mode swap when creds drop (mirror the
digilockerClient/googleDriveClient post-cred swap pattern documented at
1babe1b/192de86).

**What's now possible:**
- Caller code can invoke `callifiedClient.initiateCall()` and `fetchCallResult()`
  and get structured stub responses (no longer throws "integration not configured")
- Operator can set per-tenant cap override via /api/tenant-settings + toggle
  enable/disable via the same surface (admin UI in flight)
- Tests can spy on `module.exports.initiateCall` / `fetchCallResult` per the
  CJS self-mocking seam

**Sandbox mock clarification:** `scripts/sandbox/callified-mock.js` (referenced
in Portal matrix O17 as 🟡 PARTIAL) is the **INBOUND** simulator — used for
testing the Callified→CRM webhook flow against `backend/routes/external.js`.
It is **NOT** a swap-point for this **outbound** client. Per the new client's
header, the swap-point is the `fetch()` placeholder lines inside `initiateCall`
+ `fetchCallResult`. The two surfaces are independent — `callified-mock.js`
remains a 🟡 PARTIAL gap on its own track and does not block this PRD's
real-mode swap.

**Still pending:**
- Real-mode swap (cred-blocked on Q1 Yasin handover — Callified API key + persona library access)
- Dispatcher cron `backend/cron/aiQualificationDispatcher.js` (5-min tick;
  consumes the client + applies DC-2 lead-source whitelist at caller layer)
- Schema additive columns: 6 nullable on `Contact` + 1 on `Tenant` + new `CallifiedConfig` model
- Webhook-in summary endpoint extension to `backend/routes/external.js`
- `LeadDetail.jsx` AI summary panel (additive to commit `a84289e`)
- Persona + script content per sub-brand (DC-3 — Yasin's content team)
- TRAI / opt-out / AI-agent-disclosure counsel review (DC-5 wording — Travel Stall counsel)

**Path to real-mode:** When creds drop, swap the stub-mode canned response bodies
in `initiateCall` + `fetchCallResult` with real Callified `fetch()` calls. Cap /
observability / 90s ceiling / feature-flag / disable-toggle scaffold stays
unchanged. ~1 day post-cred per the 3-similar-stubs pattern that's now established
(adsgpt + ratehawk + callified all built on the same skeleton in successive ticks;
bookingExpedia in-flight this tick is the 4th).

---

| Component | State | Notes |
|---|---|---|
| Partner-API inbound (Callified → CRM) | ✅ SHIPPED | [`backend/routes/external.js`](../backend/routes/external.js) — `/calls` POST + `/calls/:id` PATCH + `/leads` POST + `/leads` GET + `/messages` POST already live |
| Sandbox mock for stub-mode | 🟡 PARTIAL | Portal matrix O17 evidence references `scripts/sandbox/callified-mock.js` but the file does not currently exist — INBOUND simulator, NOT a swap-point for this outbound client (see 2026-05-24 update above) |
| Outbound trigger client `services/callifiedClient.js` (STUB-mode) | ✅ SHIPPED | Commit `9ec52df` — 10/10 vitest, cap-wired, DC-1/DC-2/DC-3/DC-5/DC-7 implemented |
| Outbound trigger client `services/callifiedClient.js` (REAL-mode swap) | 🔴 NOT-STARTED | Cred-blocked on Q1 |
| Dispatcher cron `aiQualificationDispatcher.js` | 🔴 NOT-STARTED | 5-min tick; ad-source gating + per-tenant cap enforcement |
| Schema additive columns | 🔴 NOT-STARTED | 6 nullable columns on `Contact` + 1 on `Tenant` + new `CallifiedConfig` model |
| Webhook-in summary endpoint | 🔴 NOT-STARTED | Extends `backend/routes/external.js` partner-API surface |
| `LeadDetail.jsx` AI summary panel | 🔴 NOT-STARTED | Additive to commit `a84289e` |
| Q1 Callified handover (Yasin) | ⏸️ BLOCKED | Section 13 packet (multi-vendor: Callified + AdsGPT + Google Workspace) |
| 7 product decisions (DC-1 … DC-7) | ⏸️ BLOCKED | Single ~30-min Yasin-call recommended |
| Persona + script content per sub-brand (DC-3) | ⏸️ BLOCKED | Yasin's content team; GS provides starter templates |
| TRAI / opt-out / AI-agent-disclosure counsel review | ⏸️ BLOCKED | DC-4 + DC-5 + OQ-7 — Travel Stall counsel |
| Engineering time post-handover + decisions | — | **~2-3 days** per cluster C6 (stub-mode client → real-mode swap on cred-drop) |

---

**Ownership chain:**

- **Travel Stall (Yasin)** owes the Q1 Section 13 packet (Callified.ai
  slice — API docs + production keys + per-sub-brand persona signoff) +
  the 7 product decisions (DC-1 … DC-7) — outstanding per cluster C6 in
  [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md).
- **Travel Stall counsel** owes the DC-4 / DC-5 / OQ-7 wording reviews
  (similar shape to Aadhaar consent at
  `docs/TRAVEL_AADHAAR_CONSENT_DRAFT.md`, commit `7d162cd`).
- **GS engineering** owes the stub-mode client + dispatcher + webhook +
  UI (~2-3 days), then the real-mode swap on Q1 cred-drop (~½ day).
- **Callified.ai (sister Globussoft product)** owes the API spec +
  per-tenant key issuance + persona library + sub-second
  language-switch tuning (W2 target).

# Airline Web Check-in Automation — Product Requirements

**Status:** SPEC — not yet started. Tracking layer (cron scheduler +
status lifecycle + boarding-pass upload + deliver endpoints) **already
ships**; this PRD covers the missing **automation engine + per-airline
adapters** that perform the actual check-in via a headless browser. Six
hand-over decisions block kickoff (§5).

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §4.6 +
§6.3 (Operations / Ops automation) + portal matrix rows O24 / O25 / O26
in [TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md](TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md);
backlog cluster B5 in [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md).

**Audience:** Yasin (decision owner of DC-1 / DC-2 / DC-5), GS engineering
(implementation), Travel Stall + TMC ops (end-beneficiaries).

**Engineer-days estimate:** ~5-7 days for MVP (4 airlines + engine +
containerization + health dashboard scaffold). Per-airline adapter
~2-3 days each. **Ongoing per-airline DOM maintenance** budget (~75
engineer-hr / year across 4 airlines) — airlines change DOM monthly
and the adapters need a named owner.

**Paired PRD:** [PRD_FLIGHT_PLUGIN_CHROME_EXTENSION.md](PRD_FLIGHT_PLUGIN_CHROME_EXTENSION.md)
(cluster B4). Both surfaces use the same per-airline DOM-adapter pattern;
Phase 2 consolidation flagged in §8.

---

## 1. Background

Airline web check-in is the **single most repetitive ops task** in the
Travel CRM workflow — especially for TMC school trips, where one trip
typically means 25-30 students × 2 flight legs × per-leg check-in =
**~60 manual check-in operations per trip**. Today every one of those
is performed by hand:

1. Advisor opens the airline's check-in page in a browser
2. Pastes the PNR + last name from the CRM
3. Selects a seat (aisle / window per the parent's note in `Contact.preferenceJson`)
4. Saves the boarding pass PDF
5. Uploads the PDF back to the CRM via the existing
   `/api/travel/webcheckins/:id/upload-boarding-pass` endpoint
6. Triggers `/deliver` to forward to the parent via WhatsApp (today: stub)

Each pass takes ~2-3 minutes once the airline page is open; multiply by
60 per trip and a single school-trip departure is **2-3 hours of pure
typing per advisor**. Across the Travel Stall + RFU brand mix this is
~15-25 advisor-hours per month of mechanically scriptable work.

### 1.1 Source attribution

The automation requirement originates from **one line in Yasin's
clarifications email** (`travel-crm/Understanding and clarifications - Yasin.pdf`,
2026-05-13 16:48 IST → chandrikapaul@globussoft.in /
souravpatra@globussoft.in / sumit@globussoft.com). Under "Additional
clarifications we need from you," Yasin wrote:

> **Web check-in:** airline-by-airline rollout sequence; which airlines
> are reliably automatable today vs MCP-later; fallback threshold to
> agent task.

That single line carries 3 distinct asks: (a) rollout sequence
(which airlines first?); (b) automation method (deterministic browser-
driver vs LLM-driven MCP); (c) fallback threshold (when to escalate to
human). §5 below answers all three with GS recommendations.

### 1.2 What ships today vs what this PRD adds

| Layer | What ships today | This PRD adds |
|---|---|---|
| Schema | `WebCheckin` model with full status lifecycle (`pending → reminded → in-progress → done`, plus `fallback-agent` / `failed`) | — (no schema change needed) |
| Cron scheduler | `backend/cron/webCheckinScheduler.js` flips `pending → reminded` at window-open + `reminded → fallback-agent` at +30min stall | One new cron: `webCheckinAutomation.js` that picks up `reminded` rows and **actually performs the check-in** |
| Routes | `backend/routes/travel_webcheckin.js` — 8 endpoints (list / upcoming / get / create / patch / upload / deliver / delete) | One new POST endpoint to manually re-trigger automation per row |
| Browser runtime | None | Playwright + Chromium in a containerized cron pod |
| Per-airline adapter | None | 4 adapter modules (`services/airlineAdapters/{indigo,airindia,vistara,emirates}.js`) |
| Health dashboard | None | `/travel/automation-health` page surfacing per-airline success rates |

**Source-of-truth chain:**
```
Yasin's email (2026-05-13)             ← 1-line ask
  └─ Portal matrix O24 (W4, P1)         ← surface-area + state (MULTI-DAY)
       └─ Manual-coding backlog B5       ← 5-7d estimate + Playwright-decision
            └─ this PRD (live)            ← formal spec; 6 decisions blocking kickoff
                 └─ webCheckinAutomation.js + adapters
                      └─ (downstream) /deliver via Q9-cred WhatsApp send
```

---

## 2. Use cases

### 2.1 Primary — single-row automated check-in

1. A `WebCheckin` row reaches `windowOpenAt` (T-48h for most airlines;
   T-24h for legacy carriers).
2. The existing scheduler flips `pending → reminded`.
3. The new `webCheckinAutomation.js` cron picks up the `reminded` row
   on its next 15-min tick.
4. Status flips to `in-progress`; Playwright spins up; per-airline
   adapter loads the airline check-in URL with PNR + last name.
5. Adapter fills the form, selects seat preference (from
   `Contact.preferenceJson.seatPreference`; default aisle), generates
   the boarding pass PDF.
6. Engine uploads the PDF via the existing
   `/upload-boarding-pass` endpoint → row flips to `done`,
   `boardingPassUrl` is populated.
7. Engine fires the existing `/deliver` endpoint → parent gets the
   boarding pass via WhatsApp (cred-blocked Q9 today; once unblocked
   the loop is fully automated).

### 2.2 Bulk processing — TMC trip departure

For a TMC trip with 30 students × 2 legs = 60 `WebCheckin` rows opening
within the same ~6-hour window:

- Engine queues them per-airline (each adapter has its own per-airline
  concurrency limit — see FR-3).
- Max 5 concurrent headless browsers per airline; queue with exponential
  backoff between batches (avoids airline rate-limit + ToS-abuse
  concerns).
- Realistic wall-clock for the full 60-row batch: ~15-20 minutes when
  all 4 airlines are stable; longer when any single airline's
  success rate is degraded.

### 2.3 Retry on transient failure

- 3 attempts per row, exponential backoff (1 min / 5 min / 15 min)
- Each attempt logs `attemptsJson` with `{at, result, errorReason}` so
  the operator can see what failed
- 3rd persistent fail → `status='fallback-agent'` (the existing
  scheduler's fallback path) + audit log + ops notification

### 2.4 Fallback to human (advisor manual completion)

- Status `fallback-agent` triggers an ops notification via the existing
  `Notification` model (already wired in scheduler)
- Advisor manually performs the check-in via the airline's UI
- Advisor uploads the resulting PDF via existing `/upload-boarding-pass`
- Existing `/deliver` endpoint forwards to parent

### 2.5 Operator override — skip automation

- Advisor can mark `WebCheckin.automationSkipped=true` via PATCH (new
  field, additive schema change)
- Engine skips that row forever; only manual path applies
- Use case: when the parent's preference is unusual (specific seat
  number, special-needs flag) and the adapter's heuristics may not
  honor it correctly

### 2.6 Manual re-trigger

- New endpoint `POST /api/travel/webcheckins/:id/automation/retry`
  resets `status='reminded'` + clears `attemptsJson`
- Engine picks up on next tick
- Use case: airline portal was down at original window; advisor
  manually triggers re-attempt after airline confirms portal restored

---

## 3. Functional requirements

| FR-ID | Requirement | Status |
|---|---|---|
| FR-1 | **NEW engine `backend/cron/webCheckinAutomation.js`** — runs every 15 min; queries `WebCheckin WHERE status='reminded' AND automationSkipped IS NULL` ordered by `departureAt asc`; per-row picks up the per-airline adapter and performs the check-in. | 🔴 NOT-STARTED |
| FR-2 | **Per-airline adapter shape** — each adapter at `backend/services/airlineAdapters/<airline>.js` exports `{ checkInUrl(pnr), submitCheckIn(page, {pnr, lastName}), selectSeat(page, preference), downloadBoardingPass(page) }`. One airline's DOM change never touches another's code. | 🔴 NOT-STARTED |
| FR-3 | **Initial airline coverage** (MVP target per DC-2 / DC-3): IndiGo + Air India + Vistara + Emirates. Covers ~85% of TMC + RFU + Travel Stall flight volume per business mix. Each adapter ~2-3 days. | 🔴 NOT-STARTED |
| FR-4 | **Browser runtime: Playwright** (chromium headless). Vendor-supported, deterministic, free. MCP-via-LLM ruled out per DC-1 (cost + non-determinism + reliability variance vs Playwright's mature ecosystem). | 🔴 NOT-STARTED |
| FR-5 | **Seat preference resolution** — read from `Contact.preferenceJson.seatPreference` ∈ `{aisle, window, not-bothered}`; default `aisle` for `null`. Per-trip override available via `WebCheckin.seatPref` (existing column). | 🔴 NOT-STARTED |
| FR-6 | **Retry policy** — 3 attempts per row with exponential backoff (1min / 5min / 15min); each attempt logs `attemptsJson += {at, result, errorReason}` on the existing column. Persistent fail → flip `status='fallback-agent'` + write `AuditLog` row + emit ops `Notification` (already wired in scheduler). | 🔴 NOT-STARTED |
| FR-7 | **Captcha handling** — if the adapter detects a captcha challenge on the airline page → immediate `status='fallback-agent'` (no captcha-bypass attempts; legal grey area + ToS-abuse risk). One audit row per captcha hit for forensics. | 🔴 NOT-STARTED |
| FR-8 | **Per-airline health metric** — every adapter run emits `{airline, outcome, durationMs, errorReason?}` to `WebCheckinAutomationRun` (new model — additive migration). Rolling 24h success rate surfaced at `GET /api/travel/automation-health/per-airline`; UI page `/travel/automation-health`. Threshold drop <60% → ops alert per OQ-4. | 🔴 NOT-STARTED |
| FR-9 | **Boarding-pass output** — engine uploads PDF via existing `POST /upload-boarding-pass` (no new endpoint needed); `WebCheckin.boardingPassUrl` populated; `WebCheckin.completedAt` (new column — additive) = now. | 🔴 NOT-STARTED (column add only) |
| FR-10 | **Audit trail** — every attempt outcome (`success / 3rd-retry-fail / captcha-hit / dom-change-detected / portal-down`) logged via `writeAudit("travel.webcheckin.automation.<outcome>", {webCheckinId, airline, attempt, ...})` for forensic + regulatory traceability. | 🔴 NOT-STARTED |
| FR-11 | **Operator override** — new column `WebCheckin.automationSkipped` (additive); engine query excludes rows where this is true; PATCH endpoint flips it. | 🔴 NOT-STARTED |
| FR-12 | **Manual re-trigger** — `POST /api/travel/webcheckins/:id/automation/retry` resets `status='reminded'` + clears `attemptsJson`. ADMIN+MANAGER gated. | 🔴 NOT-STARTED |
| FR-13 | **Completion notification** — engine reuses existing `/deliver` endpoint (which today is a Q9-stub for WhatsApp). When Q9 unblocks, automation → boarding-pass-delivered loop is end-to-end zero-touch. | ✅ existing endpoint; just call from engine |

---

## 4. Non-functional requirements

| NFR | Target |
|---|---|
| **Per-check-in time budget** | 30 s p95 from adapter-start to boarding-pass-PDF-saved (most airlines load + form-fill in 15-25s; outliers in 60-90s). 60s hard timeout per attempt. |
| **Concurrency** | Max 5 parallel headless browsers per airline (per-airline tunable env var). Across 4 airlines that's max 20 concurrent Playwright instances; sized for the cron-worker pod accordingly. |
| **Resource footprint** | ~150 MB per Playwright instance × 20 max = ~3 GB peak. Cron-worker pod sized at 4 GB / 2 CPU (~50% headroom). Steady-state ~500 MB (idle pool). |
| **Throughput** | A TMC trip's 60-row batch completes within 15 min wall-clock (math: 5 concurrent × 6 batches × 30 s = ~3 min; with retries / queue waits = ~15 min realistic). |
| **Reliability** | Per-airline adapter is independent — one airline's DOM change never breaks another's automation. The §3.8 health metric is the early-warning signal; FR-7 fallback is the safety net. |
| **Resilience** | Engine survives airline portal down, captcha challenges, A/B-test DOM variants, network errors — every error class lands in the fallback-agent path within at most 3 retries (total ~30 min). |
| **Compliance** | Never store airline credentials; PNR + last name only (the parent's airline-login is NOT used — these are "self-service" check-ins for the named passenger, ToS-compliant per the airline's standard "passenger self-service" clause). DC-5 covers pre-launch ToS audit. |
| **Privacy** | Boarding-pass PDFs uploaded via existing `Attachment` storage; encrypted at rest via existing `fieldEncryption.js`; retained per the existing retention engine (passport / Aadhaar are 24m; boarding passes inherit). |

---

## 5. Hand-over requirements — decisions needed before implementation

Six decisions blocking kickoff. Each one has a GS recommendation; the
recommendation lands by default if Yasin has no objection.

### DC-1. Browser runtime: Playwright vs MCP-via-LLM

**Decision:** which headless-browser runtime drives the per-airline
adapters?

**Background:** two options, each with a different cost / reliability
profile.

| Option | Pros | Cons |
|---|---|---|
| **Playwright** (recommended) | Deterministic; free; vendor-supported by Microsoft; mature ecosystem; debugger / trace-viewer / video-recording built in; tens-of-thousands of production deployments | Per-airline adapter must be written + maintained; airlines change DOM monthly |
| MCP-via-LLM (Anthropic Computer Use API or similar) | Adapter-free (LLM "sees" the airline page + drives it); resilient to DOM change | Cost (~$0.50-1 per check-in × 250+/month = ~$200/mo); non-deterministic (LLM can hallucinate seat selection); slower (~60-90 s vs Playwright's 30 s); reliability variance; vendor lock-in |

**Recommendation:** **Playwright**. The DOM-change maintenance burden
is real (~75 engineer-hr / year across 4 airlines per §3) but it's
predictable and the per-check-in cost is zero. MCP only makes sense if
DOM-change maintenance dominates total cost — that's a Phase-3
reconsideration after we have a year of operational data, not a Phase 1
choice.

**Owner:** Yasin (informed by GS engineering tradeoff write-up).
**Blocks:** every per-airline adapter; the engine's runtime.
**Cost to defer:** Phase 1 can default to recommendation if no
objection by sprint start.

### DC-2. Initial airline priority

**Decision:** which 4 airlines ship in V1?

**Background:** advisor traffic profile per the
[portal matrix O24](TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md) + Yasin's
clarification ("airline-by-airline rollout sequence"):

| Airline | Brand mix | Volume per month | Phase recommendation |
|---|---|---|---|
| **IndiGo** | TMC + Travel Stall (domestic dominant) | ~50-80 check-ins | **Phase 1** |
| **Air India** | TMC + RFU + Travel Stall (mixed domestic + international) | ~40-60 | **Phase 1** |
| **Vistara** | Travel Stall + TMC (premium domestic) | ~25-40 | **Phase 1** (note: 2026 merger with AI may collapse this into AI by Phase 2) |
| **Emirates** | RFU + Travel Stall (international families + Umrah) | ~30-50 | **Phase 1** |
| SpiceJet | TMC + budget-segment Travel Stall | ~15-25 | Phase 1.5 |
| Air India Express | RFU (Saudia routes) | ~10-20 | Phase 1.5 |
| Qatar Airways | RFU + premium Travel Stall | ~10-20 | Phase 1.5 |

**Recommendation:** Phase 1 = **IndiGo + Air India + Vistara + Emirates**
covers ~85% of monthly check-in volume. SpiceJet + AI Express + Qatar in
Phase 1.5 (each ~2-3 days additional).

**Owner:** Yasin (operator-volume signal).
**Blocks:** which adapter is sprint-1 vs sprint-2.
**Cost to defer:** can default to recommendation if no answer by sprint
start.

### DC-3. Containerization / hosting

**Decision:** how is Playwright + Chromium deployed alongside the cron
worker?

**Background:** Playwright needs Chromium installed (~150 MB binary
+ ~150 MB per running instance). The current backend runs as a single
PM2 process on a bare Ubuntu VM at `163.227.174.141`.

**Two options:**

| Option | Pros | Cons |
|---|---|---|
| **Containerize the cron worker** (recommended) | Isolates the Playwright dependency; easier to scale horizontally if check-in volume grows; matches industry-standard "headless browser in a pod" pattern | New Dockerfile + container registry + deploy pipeline change (~1-2 days devops work) |
| Install Chromium directly on the existing PM2 VM | Zero infra change | Couples Playwright's dependency to the main backend lifecycle; harder to scale; upgrade churn affects production API uptime |

**Recommendation:** **containerize**. The 1-2 days of devops work is a
one-time cost; the operational benefit (isolated dependency + horizontal
scale) is forever. Suggested approach: new Docker image
`globussoft-crm-webcheckin-worker`; deploy as a separate
`pm2-runtime` process on the same VM (or a sidecar pod once we move to
k8s).

**Owner:** GS engineering lead.
**Blocks:** sprint-1 scaffolding (the Dockerfile + deploy.yml extension).
**Cost to defer:** Phase 1 can use option B (direct install) for the
first 2 weeks; switch to container once production volume warrants.

### DC-4. Retry policy on `fallback-agent` rows

**Decision:** once a row hits `fallback-agent`, does the cron ever
re-attempt automation, or is it manual-forever?

**Background:** today the existing scheduler flips `reminded → fallback-agent`
at the +30min stall. The new automation cron's question: if a row is
`fallback-agent` because of a transient airline portal outage that's
since recovered, does the engine try again?

**Recommendation:** **once** — at the next 15-min cron tick, the engine
re-attempts each `fallback-agent` row exactly one more time. After that,
status stays `fallback-agent` and only manual completion (via
`/upload-boarding-pass`) clears it. Rationale: protects against
transient airline portal outages (likely a 30-min-class event) while
avoiding retry-storm against a chronically-broken adapter (a multi-hour
event).

**Owner:** Yasin (ops product call).
**Blocks:** engine state-machine logic.
**Cost to defer:** can default to recommendation if no objection.

### DC-5. ToS audit — pre-launch legal review

**Decision:** does GS counsel review the 4 airlines' Terms of Service
"self-service" clauses pre-launch?

**Background:** automated browser-driver actions on airline portals
sit in a regulatory grey zone. Generally airlines permit "self-service
check-in for the named passenger" — we're acting on behalf of the
ticket-holder via the PNR + last name they provided. But:

- ToS language varies per airline (some explicit, some silent)
- Some airlines prohibit "automated systems" in their CAPTCHA-protected
  pages — we already plan to fallback on captcha hit (FR-7), so we're
  not bypassing intentional anti-bot
- Indian DPDP Act §11 (DPIA / consent) may classify this as "automated
  decision-making on personal data"

**Recommendation:** **mandatory pre-launch counsel review** of the 4
airlines' ToS docs (IndiGo + Air India + Vistara + Emirates), with
focus on the "self-service" clause + "automated systems" clause + the
DPIA framing. Estimated effort: 1 day legal review per airline = ~4
legal-hr total. Outcome: a short legal-position memo greenlighting the
automation OR flagging specific clauses that need parent-consent
language updates.

**Owner:** Yasin + GS counsel.
**Blocks:** production launch (NOT development — the engine + adapters
can be built + tested in stub mode in parallel with the legal review).
**Cost to defer:** none for development; launch-blocking once code is
ready.

### DC-6. Parent notification on completion — channel + timing

**Decision:** does the existing `/deliver` endpoint reuse satisfy the
"parent receives boarding pass" loop, or does automation need its own
notification channel?

**Recommendation:** **reuse `/deliver`** (already wired; Q9-cred-blocked
for WhatsApp but the column updates work today). Specifically: when
automation completes successfully (FR-1 / FR-9), the engine fires
`POST /api/travel/webcheckins/:id/deliver` internally so the existing
delivery loop kicks in. Single source of truth for boarding-pass
delivery — manual + automated paths converge on the same endpoint.

**Owner:** decided (recommendation stands unless Yasin objects).
**Blocks:** engine completion logic.
**Cost to defer:** N/A.

### 5.1 Vendor / partner creds

Unlike WhatsApp / DigiLocker / Callified.ai PRDs, this engine **needs
no third-party API credentials**. Playwright is self-hosted; the
airlines are accessed via their public check-in URLs; no API keys
involved. Only `chrome.storage.local`-equivalent state is the running
Playwright instance's session cookies, which are per-row ephemeral.

---

## 6. Acceptance criteria

The engine is "done" when **all 6 of the following are demonstrable**:

| # | Test | Verifies |
|---|---|---|
| AC-1 | A `WebCheckin` row with `status='reminded'` + `windowOpenAt < now` + automation enabled → the new cron picks it up within 15 min → status flips to `in-progress` → on success flips to `done` with `boardingPassUrl` populated within 60 s of pickup. | FR-1 + FR-9 happy path |
| AC-2 | A row whose adapter fails 3 consecutive times (simulated by pointing the adapter at an unreachable URL) → status flips to `fallback-agent` + `AuditLog` row written + ops `Notification` queued. | FR-6 retry policy + FR-10 audit |
| AC-3 | A row whose adapter detects a captcha (simulated via injected DOM element) → status flips to `fallback-agent` **immediately** (no retry) + 1 audit row + 1 notification. | FR-7 captcha handling |
| AC-4 | Simultaneous batch of 30 rows (simulated TMC trip) all opening within the same 15-min window → all 30 process within 20 min wall-clock under steady-state airline conditions. | NFR concurrency + throughput |
| AC-5 | Per-airline health endpoint `GET /api/travel/automation-health/per-airline` returns `{indigo: {successRate24h: 0.92, lastFailure: ...}, ...}`. UI page `/travel/automation-health` renders the 4 airline cards. When IndiGo's success rate drops below 60% over 1h, ops gets alerted (channel per OQ-4). | FR-8 health metric |
| AC-6 | Advisor sets `WebCheckin.automationSkipped=true` via PATCH → cron skips that row on next tick (verified via 0 attempt entries in `attemptsJson` after >15 min) → manual `/upload-boarding-pass` still works. | FR-11 operator override |

GS owns the e2e validation; Yasin owns acknowledging acceptance.

---

## 7. Out of scope

- **International airlines beyond Emirates in V1** — Etihad, Singapore
  Airlines, British Airways, Qatar Airways are Phase 1.5 by demand
  signal from the §3.8 health dashboard.
- **Aggregator portals** (MakeMyTrip / Cleartrip / Skyscanner) — Phase 1
  is airline-direct only. Aggregators have stronger anti-bot + higher
  legal-risk profile + don't issue boarding passes themselves.
- **Paid seat selection / extra-legroom / business-class upgrade** —
  Phase 1 only supports free seat selection (aisle / window / not-bothered).
  Paid-seat workflows would need passenger payment-method storage —
  out of scope per FR-7 captcha-discipline + privacy stance.
- **Multi-leg / connecting flights as a single transaction** — V1
  treats each leg as a separate `WebCheckin` row; engine processes each
  independently. Group-leg consolidation is a Phase 2 ops feature.
- **Frequent-flyer login / mileage credit on check-in** — would require
  per-passenger stored airline credentials. Out of scope per the
  no-credentials privacy stance.
- **Group / family check-in** — TMC trips will check in students
  individually (each row independent). Group-consolidation is a Phase 2
  ops feature when ops feedback warrants.
- **MCP-via-LLM browser driver** — DC-1 decided Playwright. MCP is a
  Phase 3 reconsideration only if DOM-change maintenance proves to
  dominate operational cost.
- **Captcha-solving / anti-bot bypass** — out of scope. When an
  airline serves captcha, engine falls back to human (FR-7). Captcha
  bypass would void the "self-service ToS-compliant" stance from §4.

---

## 8. Dependencies + downstream

### 8.1 Existing infra (no change needed)

| Item | Status | Path |
|---|---|---|
| `WebCheckin` model + status enum | ✅ SHIPPED | `backend/prisma/schema.prisma:4387+` |
| `webCheckinScheduler` cron (window-open + stall-fallback) | ✅ SHIPPED | `backend/cron/webCheckinScheduler.js` |
| Operator CRUD + upload + deliver endpoints | ✅ SHIPPED | `backend/routes/travel_webcheckin.js` (8 endpoints) |
| Per-window math (T-48h / T-24h table) | ✅ SHIPPED | `backend/lib/webCheckinWindow.js` |
| Operator UI surface | ✅ SHIPPED | `frontend/src/pages/travel/WebCheckinQueue.jsx` |
| `Attachment` blob storage for boarding-pass PDFs | ✅ SHIPPED | wellness `Attachment` model + storage helper |
| `AuditLog` model + `writeAudit` helper | ✅ SHIPPED | `backend/routes/audit.js` |
| `Notification` model + ops notification flow | ✅ SHIPPED | scheduler already wires this |
| Sub-brand config (per-WABA WhatsApp routing) | ✅ SHIPPED | `backend/lib/subBrandConfig.js` |

### 8.2 This PRD adds (new code)

| Item | Status | Est. work |
|---|---|---|
| `backend/cron/webCheckinAutomation.js` engine | 🔴 NOT-STARTED | ~1-1.5 days |
| `backend/services/airlineAdapters/indigo.js` | 🔴 NOT-STARTED | ~2-3 days |
| `backend/services/airlineAdapters/airindia.js` | 🔴 NOT-STARTED | ~2-3 days |
| `backend/services/airlineAdapters/vistara.js` | 🔴 NOT-STARTED | ~2-3 days |
| `backend/services/airlineAdapters/emirates.js` | 🔴 NOT-STARTED | ~2-3 days |
| `WebCheckinAutomationRun` Prisma model (per-attempt audit) | 🔴 NOT-STARTED | ~0.5 day (additive migration) |
| `WebCheckin.automationSkipped` + `WebCheckin.completedAt` columns | 🔴 NOT-STARTED | included in above |
| `POST /webcheckins/:id/automation/retry` endpoint | 🔴 NOT-STARTED | ~0.5 day |
| `GET /api/travel/automation-health/per-airline` endpoint | 🔴 NOT-STARTED | ~0.5 day |
| `frontend/src/pages/travel/AutomationHealth.jsx` UI page | 🔴 NOT-STARTED | ~1 day post-MVP |
| Dockerfile + deploy pipeline extension (DC-3) | 🔴 NOT-STARTED | ~1-2 days devops |
| `e2e/tests/webcheckin-automation-api.spec.js` gate coverage | 🔴 NOT-STARTED | ~0.5 day |

**MVP total: ~5-7 days (engine + 4 adapters + DB / endpoint scaffolding).
Health dashboard + containerization +1-3 days.**

### 8.3 Cross-cutting dependencies (other open PRDs)

- **Q9 (WhatsApp / Wati BSP)** — the `/deliver` endpoint is Q9-stub
  today. Engine completion will fire `/deliver`, which logs but doesn't
  actually send until Q9 lands. Engine is **not blocked by Q9** — the
  state-change loop is independent from the message-send loop.
- **PRD_FLIGHT_PLUGIN_CHROME_EXTENSION.md (cluster B4)** — shares the
  per-airline DOM-adapter pattern. **Phase 2 consolidation flagged:**
  one shared "airline adapter library" (`@globussoft/airline-adapters`
  npm package or git submodule) that both surfaces depend on. For
  Phase 1 keep them separate to avoid coupling pressure. Re-evaluate
  at Phase 2 when both have ~3 months of operational data.

### 8.4 Downstream consumers

- **Parent / pilgrim** — receives boarding pass via WhatsApp once Q9
  lands; before then, advisor manually forwards via the existing
  WhatsApp Web channel (5.10 / 5.20).
- **Advisor** — sees per-row status + automation health in the
  WebCheckinQueue.jsx UI (already shipped) + the new
  AutomationHealth.jsx UI (post-MVP).
- **Ops manager** — receives alerts via OQ-4 channel when per-airline
  success rate degrades + can drill into per-row `attemptsJson` for
  forensics.
- **Per-airline adapter owner** (a named GS engineer per OQ-2) —
  receives the alert + investigates DOM change + ships fix.

---

## 9. Open questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | DC-1 / DC-2 / DC-3 / DC-4 / DC-5 / DC-6 design calls (sole agenda for a ~30 min Yasin + GS engineering lead sync). | Yasin + GS engineering lead |
| OQ-2 | Per-airline DOM-change maintenance owner — single GS dev as named owner per airline (4 engineers total), or shared rotation across the travel team? Shared rotation risks "everyone's job is no-one's job"; named-owner concentrates context. Recommend: named-owner per airline + shared backup. | GS engineering lead |
| OQ-3 | Dev / staging testing strategy — how do we test airline DOM changes without booking real flights? Options: (a) sideload a test booking on a sandbox PNR (airlines don't generally have staging envs); (b) record-and-replay the airline's HTML via Playwright trace recording (allows DOM-stability tests without live network); (c) maintain a per-airline mock server. Recommend: option (b) — Playwright trace recording is mature and free. | GS engineering |
| OQ-4 | Per-airline health-degradation alerting channel — Slack? WhatsApp ops? Email? GH issue auto-file? Most operationally useful is auto-filing a GH issue against this repo (or a dedicated `globussoft-airline-adapters` repo) so the per-airline owner sees it in their normal triage. | GS engineering lead |
| OQ-5 | Should the engine cache + reuse the boarding-pass barcode for re-issuance? Some airlines invalidate boarding-pass barcodes >12 h after issuance; if the cron runs at T-48h and the flight is at T-0, the barcode may not work at the gate. Two approaches: (a) defer engine pickup to T-12h to ensure barcode validity, or (b) ignore + accept that the advisor may need to re-issue if checked in too early. Recommend: defer to T-12h pickup window (small per-airline adjustment to `webCheckinWindow.js`). | GS engineering + Yasin |
| OQ-6 | Parent opt-out — what if a parent specifically wants to do their own check-in (e.g. preference for paid seat upgrade)? Does the engine skip automation entirely for that parent? Recommend: yes — add `Contact.preferenceJson.webCheckinAutomationOptOut = true` field that the engine respects. Captures DPDP §11 "automated decision-making opt-out" requirement. | Yasin + GS counsel (DC-5 dependency) |
| OQ-7 | Persistent-fail re-attempt threshold — DC-4 recommends "once after fallback-agent." Is there a per-airline override needed (e.g. an airline whose portal is consistently flaky might warrant 3 re-attempts)? Recommend: start uniform; add per-airline override only if §3.8 health data warrants. | GS engineering |
| OQ-8 | Phase-2 multi-leg consolidation — when one parent has 4 students × 2 legs = 8 rows, do we batch them in the same Playwright session to avoid 8 separate logins? Some airlines support multi-PNR check-in via the same family identifier; others don't. Recommend: defer to Phase 2 after volume data shows the optimization is worth the adapter complexity. | GS engineering |

---

## 10. Status snapshot

- **Tracking layer (cron + status lifecycle + boarding-pass upload + deliver)** ✅ SHIPPED
  — `backend/cron/webCheckinScheduler.js` + `backend/routes/travel_webcheckin.js` + `frontend/src/pages/travel/WebCheckinQueue.jsx`
- **Automation engine `webCheckinAutomation.js`** 🔴 NOT-STARTED
- **Per-airline adapters × 4** (IndiGo + Air India + Vistara + Emirates) 🔴 NOT-STARTED — ~2-3 days each = ~10 days total
- **Containerization for Playwright** 🔴 NOT-STARTED — Dockerfile + deploy pipeline extension (DC-3)
- **Per-airline health metric + UI** 🔴 NOT-STARTED — backend endpoint + AutomationHealth.jsx page
- **`automationSkipped` + `completedAt` schema additions + `WebCheckinAutomationRun` model** 🔴 NOT-STARTED — additive migration
- **`POST /webcheckins/:id/automation/retry` endpoint** 🔴 NOT-STARTED
- **E2E gate coverage** 🔴 NOT-STARTED — `e2e/tests/webcheckin-automation-api.spec.js`
- **Pre-launch ToS audit** ⏸️ pending DC-5

**Engineering time to MVP after DC-1 / DC-2 / DC-3 / DC-4 / DC-6 land:**

| Phase | Work | Days |
|---|---|---|
| **Phase 1 — MVP** | Engine scaffold + state-machine | 1-1.5 |
|  | 4 per-airline adapters (IndiGo + AI + Vistara + Emirates) | 8-12 |
|  | DB additive migration (3 cols + 1 model) | 0.5 |
|  | Retry endpoint + health endpoint | 1 |
|  | Containerization (DC-3) | 1-2 |
|  | E2E gate spec | 0.5 |
|  | **Phase 1 total** | **~12-17 days** |
| Phase 1.5 (post-MVP) | 3 more airlines (SpiceJet + AI Express + Qatar) | +6-9 |
|  | AutomationHealth.jsx UI page | +1 |
|  | Multi-leg / family-batch consolidation (OQ-8) | +2-3 |
| Phase 2 | Shared airline-adapter library (consolidate with flight-plugin) | +3-5 |
|  | MCP-via-LLM reconsideration (DC-1 revisit) | +5 if pursued |

**Annual maintenance budget:** ~75 engineer-hr / year across 4 airlines
(DOM changes ~monthly per airline × 1-2 hr per fix × 4 airlines × 12
months). Per OQ-2: named owner per airline + shared backup.

**DC-5 ToS audit:** ~4 legal-hr (1 hr per airline). Runs in parallel
with development.

---

**Ownership chain:**

- **Yasin / Travel Stall** owes DC-1 + DC-2 + DC-3 + DC-4 + DC-6
  decisions (~30 min sync covers all five) + DC-5 counsel engagement
  + OQ-5 + OQ-6 calls.
- **GS counsel** owes DC-5 — ToS legal-position memo across 4 airlines.
- **GS engineering** owes the engine + 4 adapters + containerization
  + health dashboard + e2e gate + ongoing per-airline DOM maintenance.
- **GS engineering lead** owes OQ-2 (named-owner assignment) + OQ-4
  (alerting-channel decision).
- **Q9 (WhatsApp / Wati BSP)** is parallel; engine ships independently
  and lights up end-to-end once Q9 lands separately.

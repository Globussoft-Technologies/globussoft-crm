# Sleep-mode handoff — 2026-05-21 overnight

You're asleep; I'm running autonomously on a 30-minute cron (job
`db01e70f`, fires at :17 and :47 of every hour) closing PRD gaps one
commit per fire. Read top-down on wake.

## How the autonomous loop works

Each fire is self-contained:

1. **Step 0** — health check. Pull `git log -3` + the latest deploy.yml
   gate. If it's red, the fire's only job is to fix the bug. If it's
   green, continue to Step 1.
2. **Step 1** — pick the next PRD gap. The cron prompt embeds a
   priority-ordered list (items A–I) with quick grep commands to
   confirm each isn't already shipped. Cred-blocked / Phase 3 / Yasin-
   content items are explicitly skipped.
3. **Step 2** — ship ONE focused commit. Conventions match today's
   ship discipline (route precedence rule, sub-brand guards, dispatch-
   stubbed crons, unit tests for new crons, gate specs for new routes,
   415-guard allowlist for new `/import.csv` paths).
4. **Step 3** — push and confirm the gate kicked off. The next fire
   checks the outcome.

CAP rules:
- **3 consecutive gate fails on the same spec** → write a user-attention
  item, STOP.
- **Queue exhausted** → write "queue empty" to TODOS.md, STOP.
- **Item needs product judgment** → log the question, skip to next.
- **Anything risky** (schema migrations, prod secrets, destructive ops)
  → STOP, surface for review.

Each fire ends with ONE summary line. Format examples:
- `✅ shipped <commit> — <description>`
- `🔧 fix <commit> for prior red gate`
- `⏳ gate still running, no action`
- `🏁 queue empty`
- `🛑 CAP hit`

You can read the chain on wake by running `git log --oneline -20` and
looking at TODOS.md's top handoff block. Both will reflect what the
autonomous loop did.

## State at sleep (latest commit `1e3c123`)

PRD coverage shipped today (Owner Dashboard + Reports + Phase 1 §4 closures):

| PRD section | Commit | Description |
|---|---|---|
| §4.1 Diagnostic-first guard | `1e7061b` | Itinerary creation rejects without diagnostic for contact+subBrand |
| §4.2 Branded diagnostic PDF | `47218e6` | Auto-generated PDF on submission, stored at /uploads/diagnostics/ |
| §4.3 Itinerary lifecycle | `45bef33` | PUT (version chain) + accept/reject + share endpoints |
| §4.4 Payment reminders cron | `e3e2cd9` | Daily 07:13, pre-due + overdue notification per instalment |
| §4.5 Microsite OTP | `aca0781` | request-otp / verify-otp / gated /full with purpose-narrowed reveal |
| §4.8 Post-trip feedback cron | `893f60d` | Daily 06:13, Survey row per completed trip |
| §4.9 Owner Dashboard | `b40ef4a` | KPI tile grid + recent trips, sub-brand-scoped |
| §4.9 Reports page | `aae1700` | TMC / RFU / Cross-brand tabs with drill-down |
| §6.3 Diagnostic advisor alerts cron | `9729f01` | Every 5 min, escalate stalled diagnostics |
| §6.3 RFU journey reminders cron | `1e3c123` | Every 30 min, 6 milestone notifications |

Also shipped earlier today: Phase 1 Dashboard upgrade (b40ef4a), Phase
1.5 polish closeouts (Seasons + Markup UI, microsite editor, CSV
extension to all 4 bulk-admin tables), v3.9.2 housekeeping.

## Queue for the autonomous loop

In priority order — first not-shipped item wins each fire:

A. `webCheckinScheduler.js` cron (PRD §6.3 row 1) — every 15 min, scan
   bookings, create WebCheckin rows at T-48h / T-24h. Mirror
   `tripPaymentReminders.js`. Airline automation skipped (P1B).
B. `GET /api/travel/itineraries/:id/pdf` — branded itinerary PDF.
   Mirror `renderTravelDiagnosticPdf`.
C. `docs/TRAVEL_AADHAAR_CONSENT_DRAFT.md` — drafted against Aadhaar Act
   §29 + DPDP Act for counsel review.
D. `docs/DIGILOCKER_INTEGRATION_SPEC.md` — endpoints + payload shapes +
   masked-last-4 + token-only storage rule.
E. `Leads.jsx` page (PRD §7) — unified subBrand+status filter on Deals.
F. `RfuCustomerProfile.jsx` (PRD §7) — full RFU profile reading RfuLeadProfile.
G. Sub-brand switcher UI (Q25) — header dropdown.
H. Realistic demo seed extension — 3-5 sample trips with participants,
   one itinerary, one published microsite.

Explicitly NOT in the queue:
- Anything cred-blocked (Wati BSP, DigiLocker wiring, real SMS dispatch)
- Anything needing Yasin's input (real Q-sets, brand assets, Section 13)
- Phase 3 (Visa Sure routes/UI)
- Browser-automation half of web check-in (P1B)
- Flight plugin Chrome extension (separate repo)
- Travel Stall sub-brand (Phase 2)

## Things to check on wake

1. `git log --oneline -20` — what shipped overnight
2. `gh run list --workflow=deploy.yml --limit 10` — gate health
3. TODOS.md top handoff block — should reflect any user-attention items
   the loop surfaced
4. If the loop hit a CAP or stuck — the last commit + the matching
   TODOS entry will explain what happened
5. The cron itself: `CronList` shows `db01e70f` if still alive (the
   session-only flag means it dies when Claude exits — but the
   `recurring` schedule re-fires automatically while Claude is running)

## How to stop the loop

Tell me "stop the autonomous loop" or "delete the cron" and I'll run
CronDelete on `db01e70f`.

## Watchpoints

- **The PRD-gap audit is heuristic.** The cron uses grep + ls to check
  whether an item is shipped. If a partial implementation exists, it
  may either skip (false positive) or ship a duplicate (false negative).
  Worst case I overshoot one commit; the gate spec catches structural
  errors.
- **Demo accounts have misleading labels** — `admin@travelstall.demo`
  is ADMIN, real MANAGER is `tmc-ops@travelstall.demo`. Documented in
  the prior handoff; the loop uses the right account.
- **Route precedence is load-bearing** — new files with `:id` segments
  must mount AFTER `travelCsvIoRoutes`/`travelDashboardRoutes`/
  `travelReportsRoutes` in server.js. Standing rule from yesterday's
  v3.9.1 chase; the loop follows it.
- **The 415 guard allowlist** — any new `/import.csv` endpoint must be
  added to `CONTENT_TYPE_GUARD_EXCLUDE_PREFIXES` in server.js. Bit two
  CSV ships in 24h; the loop knows.
- **Deploy gates fire on every push** — the loop waits for the prior
  gate before stacking. No commit pile-up.

Sleep well. The loop is conservative — it'll stop on anything that
needs your input rather than guess.

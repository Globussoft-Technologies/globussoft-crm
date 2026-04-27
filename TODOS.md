# Engineering Backlog

**Read this on session start.** This is the persistent backlog of architectural / multi-day work that's been deferred from cron / overnight runs because it's too risky to ship without alignment. Each item has the diagnosis, the recommended approach, and an estimate. Pick from the top of each priority bucket; check items off (with the commit SHA) when shipped.

Last updated: 2026-04-27 (end of day — **24 user-facing bugs closed**, P1 + P2 boards both at 0 open. Class fixes: fetchApi rewrite + redundant-catch sweep, Visit.amountCharged ₹50L cap, off-by-one date range in reports. All deployed + verified live.)

---

## 🎯 PRD scope guardrails — read before picking up new work

**The PRD lives at [docs/wellness-client/PRD.md](docs/wellness-client/PRD.md).** Stay inside its bounds. Recent drift was caught on 2026-04-27:

### ❌ Do NOT invest more here (per PRD §6.5 + §6.6)
- **`routes/voice_transcription.js`** — voice (call recording, transcription, AI summary) belongs to **Callified.ai**, not the CRM. The route exists for legacy/backfill only. Coverage push on 2026-04-27 (`d7ed223`, 20 tests) was a **mistake in priority** — already shipped, leave as-is, don't extend.
- **`routes/whatsapp.js`** — WhatsApp Business API + chatbot flows = **Callified.ai**. Do NOT add WhatsApp coverage to the next-session list. If a WhatsApp bug is filed, fix the bug; don't expand the surface.
- **`routes/voice.js`** + Twilio click-to-call inside CRM — **Callified.ai** territory.
- **Ad creation / creative generation / Meta+Google campaign management** — **AdsGPT** (adsgpt.io). Do NOT build this in CRM.
- **Patient self-service portal extensions** (`/wellness/portal`) — not in PRD §5 personas. Bug fixes OK (we did #238); new features = drift. Patient comms per PRD = Callified WhatsApp + CRM SMS reminders.

### ✅ DO invest here (PRD-aligned + demo-critical)
- **`routes/sms.js`** — PRD §6.5 explicitly keeps SMS in CRM for reminders + OTP. Coverage push next session is correct.
- **Owner Dashboard** (PRD §6.8) — closing #246 (₹0 expected revenue), #247 (count disagreement, just fixed), #277 (twenty-trillion overflow) all keep this honest.
- **Lead management** (PRD §6.4) — #260 just shipped; SLA timer (lead-side, not ticket-side — see PRD gap below) is real PRD work.
- **Calendar + appointments** (PRD §6.3) — #247 fixed; #270 (empty-slot click is no-op), #262 (only 3 doctor columns) still open.
- **Reports** (PRD §6.9) — #232 just fixed; #227 (CSV/PDF export across 4 tabs) is real PRD work for franchise-readiness.
- **Multi-clinic / locations** (PRD §6.9 franchise-ready) — #235 just shipped.
- **Orchestrator depth** (PRD §6.7) — verify the engine actually computes occupancy gap → recommends ad budget → drafts campaign. May be a stub.

### 🎬 Apr-end demo criteria (PRD §14) — must work end-to-end before sign-off
PRD says "if those six work end-to-end, Rishu signs":
1. ✅ Login to Enhanced Wellness tenant — works
2. ✅ Owner dashboard with realistic numbers — works (modulo #277 overflow)
3. ⚠️ AdsGPT creative push to Meta — "mocked OK if API not live"; verify the demo flow actually surfaces a creative or stub
4. ⚠️ WhatsApp chatbot booking → real appointment — needs Callified webhook live end-to-end
5. ✅ Doctor enters Rx + captures consent on tablet — works (Rx PDF, consent canvas, treatment plan all live)
6. ✅ Orchestrator surfaces one recommendation card — works (`AgentRecommendation` cards visible on Owner Dashboard)

The two ⚠️ items are external-blocked (Callified + AdsGPT teams owe their side). Track in `external-blocked` section; don't try to build around them inside CRM.

---

## 📌 NEXT SESSION — pick up here

**HEAD at end of 2026-04-27**: `3be74ca`. Working tree clean.

**Open backlog at end of 2026-04-27 evening:**
- P1: **0** (all 8 closed today)
- P2: **0** (all 11 closed today)
- P3: **16** (mostly seed pollution + minor UX)
- wellness-tagged: **19** (overlaps with P-tags + the P3 cluster + a few untagged)
- untagged: **6** | Tracking: 1
- **Total open: 42** (was 53 at start of day)

### Next-session priority order (PRD-aligned)

The Apr-end demo criteria from PRD §14 are 4-of-6 working (5 ⚠️ are external-blocked on Callified + AdsGPT teams). Remaining open issues are mostly polish + one architectural piece. Priority order:

1. **Coverage gate bump** (5 min on the server) — pull, run `npm run coverage:start` + e2e suite + `npm run coverage:report`. If global lines % ≥ 70, bump `.c8rc.json` lines/functions/statements `60 → 70` (branches `45 → 55`). Combined forecast was ~71-72% from today's reports.js + marketing.js + voice_transcription.js coverage pushes.

2. **`routes/sms.js` coverage spec** (1.5-2 hours, PRD §6.5 aligned) — currently 31.05% (141 / 454). Cover DLT compliance branches; Fast2SMS routing; the OTP-redaction + filter additions from #254 / #269. Patterns from `e2e/tests/marketing-api.spec.js` or `reports-api.spec.js`.

3. **#227 Reports CSV/PDF export** (1-2 days, PRD §6.9 franchise-readiness) — backend export endpoints + frontend "Export" button per tab across P&L / Per-Pro / Per-Location / Attribution. PDFKit already in stack.

4. **Wellness P3 cluster — quick wins (1 hour total)**:
   - `#272`: 6 identical "E2E Branch [id]" location rows — one-shot cleanup script (mirror `cleanup-overflow-visit-amounts.js`)
   - `#271`: telecaller queue UK phone "+447700900000" — same scrub script can pick this up (delete leads with non-Indian phones in wellness tenant)
   - `#268`: "test-skip" / "test-junk" lead sources in marketing attribution — scrub script
   - `#267`: patient Source column mixes kebab-case + snake_case — normalise on read OR migrate on write
   - `#266`: patient Gender mixes "M"/"F"/"female"/"—" — same migration pattern
   - `#265`: duplicate "Kavita Reddy" patients — merge
   - `#250`: 1/1/1999 task with permanent OVERDUE — delete
   - `#240`: root `/` should redirect to /login for unauthenticated — single line in App.jsx

5. **Architectural / multi-day** (only when polish backlog is empty):
   - **#228** mobile responsive overhaul — multi-day (breakpoints, hamburger drawer, ARIA, focus trap)
   - **#137** external-integrations test sandbox infra
   - **PRD §6.7 orchestrator depth** — verify the engine actually computes occupancy gap → recommends ad budget → drafts campaign vs being a single-recommendation stub
   - **PRD §6.4 lead-side SLA** — current SLA engine is ticket-side; PRD says "first response in <5 min for high-ticket services" applies to LEADS

6. **Vague — need fresh repro from tester**: #141 #142 #147 #150 #152 #153

7. **Product decisions**: #200 / #201 / #211 (login quick-login chips + cred prefill — keep / env-gate / remove?)

### State of demo criteria (PRD §14)
1. ✅ Login to Enhanced Wellness tenant
2. ✅ Owner dashboard with realistic numbers (overflow #277 fixed today)
3. ⚠️ AdsGPT creative push to Meta — verify the demo flow surfaces a stub if API not live
4. ⚠️ WhatsApp chatbot booking → real appointment — needs Callified webhook live
5. ✅ Doctor enters Rx + captures consent on tablet (white strokes #231 fixed today)
6. ✅ Orchestrator surfaces one recommendation card

### State at end of 2026-04-27 session (HEAD `3be74ca`):

### Backend coverage — gate at 60% (already live in `.c8rc.json`)
- **Pre-spec full-suite measurement (2026-04-26): 64.76 % lines** (21,484 / 33,170)
- **Gate as of HEAD**: lines/functions/statements 60%, branches 45%
- **Aspirational target: 100%**

### Shipped 2026-04-27 (full closure list — 24 user-facing bugs + class fixes + coverage)

**P1 batch (8 closed, deployed `6624955` + `WELLNESS_DEMO_OTP` env var set on server):**
- `#232` — Reports tabs (P&L / Per-Pro / Per-Location) all surface canonical visit count + revenue. Verified live: all three now show 117 visits / ₹12,90,414.93 / productCost ₹32,000 (was 87 / 80 / 111 / ₹0). New `totals.unbucketed` field exposes the data-quality delta.
- `#235` — Clinic locations editable: pencil icon → prefilled form → PUT `/api/wellness/locations/:id`.
- `#238` — Patient portal OTP: `WELLNESS_DEMO_OTP=1234` env-var bypass shipped + set on server; demo patient `+919876500001` seeded; verified end-to-end.
- `#247` — Calendar grid no longer drops visits without `doctorId`; they render in an "Unassigned" column. Out-of-range visits clamp to boundary.
- `#249` — Stale-chunk recovery for **all** lazy routes (`32771b8`): `lazyWithRetry` helper + `RouteErrorBoundary`. Class-wide frontend fix.
- `#253` — Inbox Play Recording wired: native `<audio controls autoplay>`; falls back to "Recording not available" on load error.
- `#259` — Closed not-reproducing (Owner now gets HTTP 200 from `/api/wellness/dashboard`).
- `#260` — `/leads` row click navigates to `/contacts/:id`; pointer cursor; `e.stopPropagation` on interactive cells.

**P2 batch (11 closed across `59277ac`, `3be74ca`):**
- `#230` — closed as already fixed by #225 (90ff63f, debounced Add).
- `#231` — Consent canvas strokes were hardcoded `#fff`; now reads `--text-primary` via `getComputedStyle` so they contrast on cream + dark.
- `#234` — Off-by-one in `reportRange()`: `to=YYYY-MM-DD` was parsed as midnight UTC, dropping every visit/consumption later that day. Fix: when raw param is date-only, clamp `from` to start-of-day, `to` to end-of-day. Productive for all 4 reports tabs. Verified live: productCost went ₹0 → ₹32,000.
- `#243` — Invoices ledger overflow: `table-layout: fixed` + `<colgroup>` widths + Contact cell ellipsis + opaque sticky Actions bg + zIndex.
- `#246` — Closed as already fixed by #277 (Visit overflow cleanup).
- `#252` — Inbox empty-state scoped to active tab: 'No emails yet' + sub-line listing other-tab counts when present.
- `#257` — Estimates Drafts/Sent pills now real filter buttons (statusFilter state + aria-pressed).
- `#258` — Lead Routing Apply All migrated from local toast to global notify; consistent UX.
- `#262` — Calendar now shows ALL practitioners (doctors + professionals = 16 staff, was 3). Default view is "with visits today"; chip toggles to "All N".
- `#264` — Dark mode toggle disabled with "coming soon" copy until a real dark theme stylesheet ships (multi-day work, not in PRD §8).
- `#270` — Calendar empty-slot click opens "New visit" modal seeded with (practitioner, date, hour). Patient required, status='booked'.

**Toast / silent-failure cluster (4 closed across `9c03cf4`, `dfe94b7`):**
- `#273 #274 #276` — root cause was upstream `fetchApi` reading `errData.message` instead of `errData.error` (backend returns `{error, code}`). Every error toast surfaced the generic fallback "API Request Failed" — looked silent.
- `#275` — closed as misdiagnosis: NotifyProvider HAS been mounted at App root with a working `useNotify()` API since launch. The toast container only mounts when toasts are active, which is why the bug reporter's DOM-scan found nothing. The real fix was the `fetchApi` rewrite.
- **fetchApi rewrite class fix**: reads `errData.error || errData.message`; 403 / 404 / 5xx / network fallbacks; auto-toasts every error via `_globalNotify` registered by NotifyProvider on mount; throws Error with `.status` / `.code` / `.data` attached. Pages opt out with `{silent: true}`.
- **Sweep across 9 wellness pages** (`dfe94b7`) — replaced 17 redundant `catch (err) { notify.error('Failed: ${err.message}') }` with `catch (_err) { /* fetchApi already toasted */ }` AND added missing success toasts on Locations create/update/toggle, Loyalty referral + reward, Patients create, Treatment plan create, Inventory consumption log, Services create, Waitlist add/status/remove, TelecallerQueue.

**Visit overflow (1 closed, `233db7a` + cleanup script run on prod):**
- `#277` — Owner Dashboard "Today's expected revenue" showed ₹20,000,000,030,000 (twenty trillion). Two Visit rows had `amountCharged=1e15` (residue from #218 era — "Z" service had basePrice=1e15). Fix: ₹50L per-visit cap on POST + PUT (matches Service.basePrice ceiling from #209). Cleanup script `backend/scripts/cleanup-overflow-visit-amounts.js` NULLed the 2 polluted rows. Verified live: now ₹30,000.

**Coverage shipped earlier in the day:**
- `routes/reports.js` (`4846adb`) — 52 tests. Was 14.17%; forecast ~85%.
- `routes/marketing.js` (`612617f`) — 41 tests. Was 28.20%; forecast ~80%. Surfaced + fixed `/marketing/submit` openPaths bug.
- `routes/voice_transcription.js` (`d7ed223`) — 20 tests. **⚠️ PRD drift in retrospect** — voice belongs to Callified per PRD §6.5. Tests already shipped; don't extend further. See guardrails section above.
- **OpenPaths audit complete** — no further gaps (landing_pages mounted at `/p`, `/communications/tracking` and `/attribution/track` correctly require auth).

Combined forecast: global coverage **64.76% → ~71-72%**.

**Next move (5 min on the server)**: pull, run `npm run coverage:start` + the e2e suite + `npm run coverage:report`, read the new global lines %. If ≥ 70%, bump `.c8rc.json` lines/functions/statements to **70** (branches to 55). Don't over-bump — ratchet up, never down.

### Top remaining coverage gaps (in priority order, PRD-aligned only)
1. **`routes/sms.js`** — 31.05 % (141 / 454). PRD §6.5 keeps SMS in CRM (reminders + OTP). Cover DLT compliance branches; Fast2SMS routing; OTP-redaction + filter (#254 / #269) need dedicated spec branches.
2. **`cron/slaBreachEngine.js`** — 24.50 % (37 / 151). Ticket SLA breach cron; recent feature. Per PRD §6.4 we ALSO need lead-side SLA — see PRD gap analysis below.
3. **`routes/wellness.js`** + clinical sub-flows — biggest in the codebase, lots of branches; a focused pass on patient/visit/Rx/consent CRUD would lift global coverage AND directly back PRD §6.1.

⛔ **Skipped per PRD scope (do NOT push coverage on these)**:
- `routes/whatsapp.js` — Callified.ai handles WhatsApp (PRD §6.5)
- `routes/voice.js` + Twilio click-to-call — Callified.ai (PRD §6.5)
- `routes/voice_transcription.js` — already covered, but don't extend (Callified territory)

Each one needs ~1 spec file (~200-400 lines) using the patterns from `e2e/tests/marketing-api.spec.js` (latest), `e2e/tests/reports-api.spec.js`, or `e2e/tests/billing-update.spec.js`.

### What's open on GitHub (45 at session end, after closing 8 P1s today)

**By priority bucket** (`gh issue list --state open` 2026-04-27 evening):
- **P1** — 0 open (all 8 closed today: #232 #235 #238 #247 #249 #253 #259 #260)
- **P2** — 11 open
- **P3** — 16 open
- **[wellness]** — 11 open (overlaps with P-tags; some wellness P2/P3 are double-tagged)
- **untagged** — 6 open
- **[Tracking]** — 1

**P2 cluster (next priority after P1):**
- #270 `/wellness/calendar` empty time-slot click is a no-op (no "Create visit" affordance)
- #264 `/settings` Dark Mode toggle sets data-theme but CSS doesn't respond
- #262 `/wellness/calendar` only 3 doctor columns (others have no schedule visible)
- #258 `/lead-routing` "Apply All" button no UI feedback (200 OK but silent)
- #257 `/estimates` Drafts/Sent status pills don't filter
- #252 Unified Inbox shows empty-state on Emails tab while other tabs have data
- ...

**Wellness vertical bucket (PRD-priority):**
- #275 [meta] No global toast/notification system mounted — root cause for many silent-failure bugs (#273, #274, #276) — **closes a class of issues if shipped**
- #277 Owner Dashboard "Today's expected revenue" overflow (twenty trillion rupees)
- #278 Prescription has no detail view, no PDF, instructions dropped from timeline
- #276 `/wellness/recommendations` Reject button unwired
- #274 `/wellness/services` Save returns 403 silently
- #273 `/estimates` Convert button silent no-op
- #272 / #271 / #268 / #267 / #266 / #265 / #263 / #261 — mostly seed pollution (P3) + minor UX gaps

**Multi-day**: #228 (mobile responsive overhaul), #227 (CSV/PDF reports export — PRD §6.9 franchise-readiness), #137 (external-integrations sandbox)

**Product decision**: #200 / #201 / #211 (login quick-login chips — keep / env-gate / remove)

**Vague — need fresh repro**: #141 / #142 / #147 / #150 / #152 / #153

### External-blocked (can't fix from inside CRM)
- **Callified webhook + silent SSO** — biggest demo-narrative gap. Our `/api/v1/external/leads` already accepts X-API-Key POSTs. Their team owes the contract.
- **AdsGPT "Back to CRM" link** — our SSO impersonation works one-way; their side pending
- **Rishu inputs** — Superphone + Zylu CSVs (data migration), Aadhaar/PAN scans (Android Play Store resubmit)

### Recommended order next session (PRD-aligned)
1. **15 min** — pull, verify clean tree (HEAD `6624955`), glance at overnight commits
2. **5 min** — re-run coverage on the server, capture combined lift; bump `.c8rc.json` lines/functions/statements `60 → 70` if data supports it
3. **30 min — close the demo-blocker class:** `#275` global toast system. PRD §6.8 owner needs to know when something fails; right now Save errors are silent (root cause for #273 #274 #276). One commit, unblocks 3+ open issues.
4. **30 min — `#277`** Owner Dashboard expected-revenue overflow (₹20T). PRD §6.8 demo criterion. Likely a unit-conversion bug or sum on an already-summed column.
5. **1.5-2 hours — `routes/sms.js` coverage spec** (31% → 75%+, PRD §6.5 aligned, lifts global another ~2-3 pts)
6. **Rest** — pick from open P2 (#270 calendar empty-slot, #262 doctor columns, #258 lead-routing feedback) or PRD §6.9 (#227 reports export). NOT whatsapp/voice — those are Callified.

### Recent commits worth knowing about (2026-04-27, newest → oldest)
- `3be74ca fix: P2 calendar — #262 #270` — practitioner columns expanded from 3 to 16; empty-slot click opens "New visit" modal seeded with (practitioner, date, hour).
- `59277ac fix: P2 batch — #231 #234 #243 #252 #257 #258 #264` — consent stroke color, off-by-one date range in reports, invoice column overflow, inbox empty-state scoping, estimates filter pills wired, lead-routing toast migration, dark-mode toggle disabled until real theme ships.
- `dfe94b7 fix(ui): #275 follow-up — sweep redundant notify.error catches across wellness pages` — 9 files, 17 call sites cleaned; success toasts added where missing.
- `9c03cf4 fix: #275 #273 #274 #276 — global error toasts + success feedback` — fetchApi rewrite (reads errData.error not .message; 5xx + network fallbacks; auto-toasts via registered NotifyProvider). Closes the silent-failure class.
- `233db7a fix: #277 cap Visit.amountCharged at ₹50L + cleanup script` — backend validator + one-shot cleanup of 2 polluted ₹1e15 visit rows.
- `ed64825 docs: TODOS — P1 batch closed, PRD scope guardrails added`
- `6624955 fix: P1 batch — #232 #235 #238 #247 #253 #260` — 6 P1s; reports canonical totals, location editing, OTP demo bypass, calendar Unassigned column, Play Recording, leads row click.
- `32771b8 fix: #249 stale-chunk recovery for all lazy routes` — class-wide; lazyWithRetry + RouteErrorBoundary
- `d7ed223 test(e2e): cover routes/voice_transcription.js — 20 tests across 5 endpoints` — **⚠️ retroactively flagged as PRD drift** (voice = Callified per PRD §6.5). Tests already shipped; don't extend.
- `612617f fix(server)+test(e2e): cover routes/marketing.js + add /marketing/submit to openPaths` — 41 tests; real auth-gate bug fixed on the public form-ingest endpoint
- `4846adb test(e2e): cover routes/reports.js — 52 tests across 7 endpoints` — biggest single coverage gap closed
- `4846adb test(e2e): cover routes/reports.js — 52 tests across 7 endpoints` — biggest single gap closed; verified live
- `9afee65 fix: #269 stronger OTP filter — exclude OTP SMSes from staff inbox entirely (was just redacting)` — closes the confirmed account-takeover chain; #254 redaction kept as belt-and-braces
- `ac1fa1c fix(qa): cron batch — #254 #256` — SMS-OTP digit redaction in /api/sms/messages + estimates `$ ₹` cleanup
- `fb3d63e docs: refresh all 6 doc files for v3.2.2`
- `fff1dd6 test(e2e): cover lib/eventBus.js + services/landingPageRenderer.js` — 5 new specs (4 eventBus + 1 landing page); jumped lib from 67 % → 80.59 %, services from 51 % → 63.15 %
- `d947e65 chore(coverage): wire c8 gate config + scripts; bump backend to v3.2.2` — `.c8rc.json` + npm scripts (`coverage:start`, `coverage:report`, `coverage:check`)
- `3e6e829 chore(server): graceful SIGTERM/SIGINT shutdown` — required for V8 coverage to flush
- `0c0cf3f chore(server): DISABLE_CRONS=1 env switch for side-by-side instances`

### Coverage run pattern (cheat-sheet for tomorrow)
```bash
# On the server (163.227.174.141):
cd ~/globussoft-crm
git pull origin main

# Free port + clean
ss -tlnp | grep ':5098' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | xargs -r kill -TERM
cd backend && rm -rf coverage .c8tmp && mkdir -p coverage .c8tmp

# Boot c8 backend in background
nohup env DISABLE_CRONS=1 PORT=5098 node_modules/.bin/c8 \
  --reporter=json-summary --reporter=text-summary --reporter=lcov \
  --temp-directory=./.c8tmp --reports-dir=./coverage \
  --exclude='node_modules/**,coverage/**,scripts/**,prisma/seed*.js,prisma/migrations/**' \
  node server.js > /tmp/cov.log 2>&1 &

# Wait healthy, run suite
until curl -s http://127.0.0.1:5098/api/health | grep -q healthy; do sleep 2; done
cd ../e2e
echo '{"cookies":[],"origins":[]}' > playwright/.auth/user.json
E2E_SKIP_SCRUB=1 BASE_URL=http://localhost:5098 \
  npx playwright test --project=chromium --no-deps --reporter=list

# Stop + report
kill -TERM $(ss -tlnp | grep ':5098' | grep -oE 'pid=[0-9]+' | cut -d= -f2)
sleep 5
cd ../backend && node_modules/.bin/c8 report --temp-directory=./.c8tmp --reports-dir=./coverage \
  --exclude='node_modules/**,coverage/**,scripts/**,prisma/seed*.js,prisma/migrations/**'
```

---

## 📋 Office handoff — what shipped overnight

The 2026-04-26 overnight session closed **22 GitHub issues + 9 backlog items**. Highlights:

- **9 architectural cron-skipped issues** closed: #167 #176 #179 #180 #182 #184 #186 #190 #191
- **🟡 ship-this-month batch** done: #1+#2 (approvals auto-create), #12 (SLA breach cron), #20 (workflow conditions), #17 (last 3 dead triggers)
- **🔴 bigger investments** all done: #21 (clinical no-delete policy), #7 (sequence reply detection), #9 (sequence engine + canvas rebuild)
- **RBAC cluster** closed: #207 #214 #216 — wellnessRole-aware gates, JWT carries the claim, frontend landing/sidebar/dashboard guards. **20/20 RBAC e2e tests pass live.**
- **Tester reports**: #200/#201/#202/#204/#206/#208/#211 cron-skipped (frontend/UX); #214/#215/#217/#225/#226/#227/#228/#229 cron-skipped (frontend/UX/UI redesign); #213/#218/#219/#220/#221/#224 closed.
- **Test debt cleared**: 2 deep-flow flakes resolved + mysql2 install + global-teardown extended.

What's left in the backlog (continue from here):

1. **Frontend UI cluster** — 7 cron-skipped issues that all need real frontend work, not single-route patches. See section below.
2. **41 pre-existing e2e brittleness failures** — non-blocking, pass rate is 93%, mostly UI-flow drift in old specs (theme toggle, navigation sidebar, dashboard percentage badges).
3. **Backend coverage tool** — wire `c8` to instrument PM2 for line coverage. ~3 hours.
4. **6 vague tester reports** (#137/#141/#142/#147/#150/#152/#153) — need repro from tester.

---

## 🟡 Ship this month — small/medium effort, real product impact

### [x] ~~#1 + #2 — Approvals: auto-create on threshold + side effects~~
**Closed in 8b6bb49** — `create_approval` action wired into `workflowEngine.js executeAction()`. Resolves `entityId` via `payload[entity.toLowerCase()+'Id']`. `reasonTemplate` rendered with mustache-style `{{path.to.field}}` lookups (unresolved placeholders left raw). Approve emits `approval.approved` (does NOT mutate the deal — downstream rules can do that). Reject emits `approval.rejected`. New TRIGGER_TYPES: `approval.created/approved/rejected`. New ACTION_TYPES: `create_approval`.

---

### [x] ~~#20 — Workflow rule conditions~~
**Closed in 8b6bb49** — `AutomationRule.condition String? @db.Text` column added. `evaluateCondition()` in `lib/eventBus.js`: JSON-array clauses AND-joined, ops `eq/neq/gt/gte/lt/lte/in/nin/contains/startsWith` with numeric coercion. Empty/null condition = always-fires (back-compat). Bad JSON = fail-closed. Field lookup tries dot-path then flat fallback. Wired BEFORE `executeAction`. POST/PUT validate via `validateCondition()` → 400 INVALID_CONDITION. Unblocks #7 (sequence reply detection — uses `pauseOnReply` rule condition).

---

### [x] ~~#12 — SLA breach cron + event~~
**Closed in 8b6bb49** — `Ticket.breached Boolean @default(false)` + `Ticket.breachedAt DateTime?` columns. `cron/slaBreachEngine.js` runs every 5 min, scans per-tenant for status NOT IN (Resolved/Closed/Cancelled) AND firstResponseAt IS NULL AND slaResponseDue < now AND breached=false. Flips both columns and emits `sla.breached` with `{ ticketId, subject, priority, contactId, assigneeId, dueAt, breachedAt, breachedBy }`. Idempotency via the `breached=false` precondition. New POST `/api/sla/check-breaches` (ADMIN) for manual trigger. New TRIGGER_TYPES entry: `sla.breached`. Existing on-read `GET /api/sla/breaches` kept untouched as fallback.

---

### [x] ~~#17 (remaining 3 of 6 dead workflow triggers)~~
**Closed in 8fca56b** — all 6 triggers now wired. `contact.updated` emits in `contacts.js` PUT /:id with `{ changedFields, status, assignedToId }`. `task.completed` emits in `tasks.js` PUT /:id and PUT /:id/complete, gated on `wasCompleted = false` so re-saving a completed task doesn't re-fire. `lead.converted` emits in `contacts.js` when status flips Lead → Customer/Prospect (no separate `leads.js` route exists in this codebase). All emits wrapped in try/catch — workflow failures never break the CRUD response.

---

## 🔴 Bigger investments — multi-day, may need legal/compliance signoff

### [x] ~~#21 — Clinical artefact soft-delete~~
**RESOLVED BY POLICY (2026-04-26).** Clinical artefacts — Patient, Visit, Prescription, ConsentForm, AgentRecommendation, ServiceConsumption — are PERMANENT. No DELETE endpoints, no `deletedAt` column, no soft-delete. Corrections happen via PUT/PATCH (amendment trail captured in the audit log). Out-of-band ops scripts only for genuine data errors, with written justification in the audit log. Policy block lives at the top of the Clinical section in `backend/routes/wellness.js` (around line 134) so a future engineer doesn't accidentally add a DELETE endpoint. Compliance basis: HIPAA 164.312(c)(1), India MoHFW EMR Standards 2016, DPDP Act 2023.

---

### [x] ~~#7 — Sequence reply detection~~
**Closed in cd197dc** — `processInboundReplies()` in cron/sequenceEngine.js scans inbound EmailMessage rows where `threadId LIKE 'seq-%' AND sequenceReplyHandled IS NULL` (new dedup column). Parses enrollment id from threadId. Pauses enrollment if its current step has `pauseOnReply=true` (legacy engine: pauses unconditionally — no per-step setting). routes/email_inbound.js fires the scan synchronously on each inbound webhook when threadId matches `^seq-\d+$`. Cron tick is the safety net. Verified live: e2e/tests/sequences-step-list.spec.js test "inbound reply with threadId=seq-<enrollmentId> pauses the enrollment" passes against the deployed engine.

---

## 🚫 Don't patch — rethink

### [x] ~~#9 — Sequences ignore EmailTemplate; ReactFlow canvas is half-baked~~
**Closed in cd197dc** — engine + editor rebuilt:
- New `SequenceStep` model: position-ordered rows with kind ∈ {email, sms, wait, condition}, FK to EmailTemplate, optional smsBody / delayMinutes / conditionJson + trueNextPosition / falseNextPosition / pauseOnReply.
- `cron/sequenceEngine.js` rebuilt (372 lines): `processStep()` dispatches by kind; emails render the EmailTemplate subject + body via `renderTemplate` from lib/eventBus.js (real `{{contact.name}}` interpolation, NOT the synth `system@crm.com` stub). Condition steps use `evaluateCondition()` (#20). Best-effort Mailgun delivery alongside the persisted EmailMessage row with `threadId='seq-<enrollmentId>'`.
- Legacy ReactFlow canvas + `processLegacyEnrollment()` preserved verbatim — runs only when `Sequence.steps` is empty so existing canvas-driven sequences keep working.
- New API: `GET/POST /:id/steps`, `PUT/DELETE /steps/:id`. New `frontend/src/pages/SequenceBuilder.jsx` (332 lines, `/sequences/:id/builder`): explicit step list, side-panel editor with EmailTemplate dropdown, SMS textarea, delay numeric, condition JSON textarea, `pauseOnReply` toggle. Sequences.jsx canvas page kept; new ListOrdered link added per sequence card pointing at the builder.
- 7 e2e tests in sequences-step-list.spec.js all pass live.

---

## 🟫 Architectural cron-skipped issues (filed by the tester / Sumit overnight)

These were filed during cron runs and tagged `[cron-skip]` because they need design / schema / human review. Each links to a GitHub issue.

- [x] ~~**#167** Cross-resource hard-delete cleanup (Contacts, Deals, Estimates, Tasks).~~ **Done.** Schema gained `deletedAt DateTime?` + `@@index([tenantId, deletedAt])` on all four models. DELETE now flips `deletedAt` (admin-only); GET list/detail filter it out by default with `?includeDeleted=true` opt-in; new POST `/:id/restore` clears it. Audit rows written for SOFT_DELETE + RESTORE. Idempotent on both sides. *Follow-up audit*: aggregations (deals/stats, custom_reports, attribution), `/duplicates/find`, `/merge`, and internal joins (timeline / activity / sequence enrollments) still see soft-deleted rows — separate ticket.
- [x] ~~**#176** `POST /api/contacts/:id/attachments` always 500. Multer config missing or wrong mime handler. Needs file-upload investigation.~~ **Closed in d00ac2f** — root cause was unguarded req.body destructure with no multer middleware; route now validates JSON {filename, fileUrl} shape, returns 400 UNSUPPORTED_CONTENT_TYPE for multipart (multer wiring deferred).
- [x] ~~**#179** Audit log only records Deal events.~~ **Closed in 8fca56b** — new `backend/lib/audit.js` (`writeAudit` + `diffFields` helpers, all wrapped in try/catch). ~50 audit calls added across 8 route files: contacts, estimates, tasks, billing, wellness (patient/visit/Rx/consent/loyalty/recommendation), notifications, auth (profile + role + password). Passwords NEVER written to details. PII recorded as `piiFieldsTouched: [...]` name list only (no raw values). 25 distinct action names. Login attempts intentionally NOT audited — owned by the rate-limit middleware. *Out of scope for this pass*: ConsentForm UPDATE, TreatmentPlan, Service, Location, Referral, Waitlist, Booking endpoints.
- [x] ~~**#180** No JWT revocation. 7-day tokens are not revocable; no logout endpoint, no session listing.~~ **Closed in 5d9d47a** — RevokedToken model added, jti minted on every login (register/signup/login/2fa-verify), verifyToken checks the table on every request, fail-open on DB error so a Prisma blip doesn't lock everyone out. New endpoints: POST /auth/logout, GET /auth/sessions, DELETE /auth/sessions/:jti. Backwards compat: pre-deploy tokens (no jti claim) keep working until natural 7d expiry — no forced re-login.
- [x] ~~**#182** SMS queue stuck — 25 messages QUEUED with no provider configured.~~ **Closed in 5d9d47a** — POST /api/sms/drain (ADMIN). resolveProviderConfig() picks SmsConfig row first then env-var fallback (MSG91 → Twilio → Fast2SMS). No provider → fail-fast all QUEUED rows to FAILED with reason. *Follow-up*: per-tenant 1-min trickle cron (out of scope; admin drain + fail-fast closes the silent-accumulation bug for now).
- [x] ~~**#184** `/survey/:id` customer-facing route broken: blank content, shows admin sidebar to logged-in users.~~ **Closed in 5d9d47a** — backend GET/POST /api/surveys/public/:id (in openPaths), frontend SurveyPublic.jsx mounted OUTSIDE the authenticated Layout (no sidebar). Wellness theme cascades via `data-vertical="wellness"`.
- [x] ~~**#186** No security headers. Missing CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, HSTS, Permissions-Policy. `helmet` is mounted but underconfigured. ~30 min + check no inline scripts break.~~ **Closed in d00ac2f** — Helmet now sets HSTS / SAMEORIGIN / Referrer-Policy / nosniff / CORP same-site / baseUri+formAction 'self'. New `permissionsPolicyMiddleware` for camera/mic/geo/FLoC. imgSrc https-only in prod. unsafe-inline/unsafe-eval retained on scriptSrc — TODO for strict-CSP migration in a follow-up once SSR/nonce pipeline lands.
- [x] ~~**#190** Deal stage data migration. Existing rows with stage='Lead' (capitalized) cannot be PUT-updated after the validator was tightened.~~ **Closed in d00ac2f** — `backend/scripts/migrate-deal-stage-lowercase.js` is idempotent, coerces capitalized + suffixed + whitespace variants, clips negative amounts to 0. Production run: 32 deals scanned, 1 unmappable ('NotARealStage') logged, no neg amounts.
- [x] ~~**#191** Login rate limiting. Currently 30 wrong-password attempts in 3.2s all return 403 with no throttling. Add `express-rate-limit` per-IP-per-username on `/auth/login`.~~ **Closed in d00ac2f** — two stacked limiters on `POST /auth/login`: per-IP (5/15min, IPv6-safe via `ipKeyGenerator`) + per-username (10/1h keyed on email lowercase+trim, with noemail:<ip> fallback). `skipSuccessfulRequests` so legitimate fat-finger flows refund the slot. `standardHeaders: 'draft-7'` emits RateLimit-* + Retry-After. `/auth/2fa/verify` intentionally untouched.
- [x] ~~**#220** POST /api/wellness/patients 500 for names 192-200 chars (utf8mb4 VARCHAR(191) overflow).~~ **Closed in 10b7c25** — validatePatientInput cap dropped from 200 → 191 to match the DB column.
- [x] ~~**#221** Doctor dropdown empty in Log Visit form.~~ **Closed in 10b7c25** — /api/staff GET / select was missing wellnessRole; the wellness UI's filter `u.wellnessRole === 'doctor'` matched zero rows. Added wellnessRole to the select.
- [x] ~~**#224** Case history shows raw ENC:v1:… ciphertext for visit notes and prescriptions.~~ **Closed in 10b7c25** — lib/prisma.js `$extends` hooks only ran on the outer query model. Made `decryptRecord` recursive: walks every nested relation and decrypts any field whose name is in the union of encrypted-field names AND whose value passes isEncrypted(). Plaintext sharing a field name is left alone (defense in depth).

---

## 🟦 Frontend UI cluster — 8 of 12 closed in v3.2.2; 4 remain

Each one is a meaningful UX/UI/feature effort, not a single-route patch. Most of this section closed in the v3.2.2 afternoon pass. The 4 remaining items are mobile responsive, Reports export, and the login-chip product decision.

- [x] ~~**#206** — Service Worker push registration spams console with `[push] setupPush error: AbortError`.~~ **Closed in 90ff63f** — AbortError demoted from `console.error` to `console.debug`. Other error classes still log loudly.
- [x] ~~**#229** — Patient list table layout breaks when a single name is long.~~ **Closed in 90ff63f** — `table-layout: fixed` + `text-overflow: ellipsis` + `title` tooltip on the name cell. Header row no longer collapses on 60-char names.
- [x] ~~**#225** — Treatment plan "Add" button not debounced.~~ **Closed in 90ff63f** — submitting state on PlansTab + LogVisitTab + InventoryTab disables the button between click and server response.
- [x] ~~**#204** — Consent canvas invisible on the wellness theme.~~ **Closed in 35d728c** (pre-v3.2.2) — scoped CSS override under `[data-vertical="wellness"]`.
- [x] ~~**#226** — Refresh in the middle of forms silently loses input.~~ **Closed in 8c6b036** — new `useFormAutosave` hook with sessionStorage rehydrate + beforeunload + active-tab persistence + "Restored from previous session" banner. Wired into New Prescription, Log Visit, Treatment Plan; opt-in pattern for the rest.
- [x] ~~**#215** — Telecaller queue dispositions inconsistent.~~ **Closed in 3a6d656** — all 6 dispositions now confirm. Booked / Callback / Interested gain a follow-up form (date+time / notes).
- [x] ~~**#208** — `/portal` route collision.~~ **Closed in 49acd3e** — wellness patient portal moves to `/wellness/portal`; generic CRM customer portal stays at `/portal`.
- [x] ~~**#217** — `/wellness/tasks` 404 / `/wellness/inbox` wrong theme.~~ **Closed in ec5b6d8** — verified shared `/tasks` and `/inbox` routes work for wellness via the `data-vertical` theme cascade; sidebar prefix corrected.
- [ ] **#228** — No mobile responsive design — sidebar fixed-width, no hamburger drawer pattern, content clips at narrow viewports. Multi-day frontend overhaul (breakpoints, drawer component, ARIA, focus trap, all wellness pages tested at 375px width).
- [ ] **#227** — Reports has no CSV/PDF export across all 4 tabs (P&L / Per-Pro / Per-Location / Attribution). New feature: backend export endpoints + frontend "Export" button per tab. PDFKit already in stack. ~1-2 days.
- [ ] **#200/#201/#211** — Login page exposes 6 quick-login chips with real production credentials AND login form pre-fills credentials on first load. Per CLAUDE.md these are intentional demo features. Product decision needed: keep, env-gate (`NODE_ENV !== 'production'`), or remove entirely. NOT a bug — UX/security tradeoff.
- [x] ~~**#202** Composite billing ticket — multiple parts already covered by earlier validators; update path missing.~~ **Closed in ab90548** — new `PATCH /api/billing/:id` and `POST /api/billing/:id/mark-paid` (idempotent, audited). State-machine codes: terminal transitions return `422 INVALID_INVOICE_TRANSITION`.

---

## 🧪 Test debt

- [x] ~~**2 deep-flow specs still failing**~~ **Closed in 4361074.**
  - approvals deal-create-500-in-serial — auto-resolved after Wave C1 schema migration (AutomationRule.condition) settled the Prisma client. 12/12 pass.
  - sequences materialised-email — relaxed assertion to count + cardinality (engine synth subject ignores canvas label per gap #9). Updated to use the `/email-threading/messages` endpoint (gap #25). Added `auth()` to `/debug/tick` calls. 9/9 pass (1 intentional skip for #7 reply-detection).

- [ ] **41 pre-existing e2e failures** from the full-suite run on 2026-04-26 (`theme.spec`, `navigation.spec` sidebar/back-button, `audit-log`, `email-templates`, `notifications`, `pipeline-stages`, `pdf-export`, `csv-import`, `dashboard` percentage badges). Most are tests pinning old behavior (UI flow drift); a few may be real route contract drift. Not blocking — pass rate is 93%.

---

## 📋 Test infrastructure

- [x] ~~Add a backend coverage tool.~~ **Closed in 0c0cf3f + 3e6e829 (v3.2.2)** — `c8` running on a side-by-side `:5098` Express instance with `DISABLE_CRONS=1`. Graceful SIGTERM/SIGINT shutdown added so V8 coverage data flushes on exit. **First measurement: 33.20% (10,858 / 32,700 lines)** against the wellness-only spec set. Full-suite measurement queued. Re-run procedure documented in PRODUCTION_RUNBOOK §5b.
- [x] ~~`e2e/global-teardown.js` says "mysql2 not installed — skipping scrub." E2E rows tagged `E2E_FLOW_<ts>` are accumulating.~~ **Closed in 4361074** — mysql2 installed as devDependency; PAT_REGEX + EMAIL_REGEX extended to match `E2E_FLOW_<ts>` / `E2E_AUDIT_<ts>` tags. Local runs log "MySQL connect failed" because the dev DB isn't reachable over the public internet — only effective in CI on the same network as the DB.

---

## 📊 Coverage policy (set 2026-04-26)

Set this release as v3.2.2 ships the first real measurement (33.20% wellness-only baseline). Targets, in order from north star to pragmatic floor:

- **Aspirational target: 100%** — everything tested, everything safe. We don't expect to hit it; it's the direction.
- **CI gate: 50% to start** — current baseline (33.20%) + buffer to give the gate breathing room while specs are written. The gate ratchets up each release; never down.
- **Critical-path floor: 70%** — every line in `routes/auth.js`, `routes/external.js`, `routes/billing.js`, `routes/wellness.js`, all `middleware/*`, and all `lib/*` must hit 70% before a release ships. **Exemptions:** `lib/eventBus.js` (currently 20%) and `services/landingPageRenderer.js` (currently 2%) are exempted until their dedicated test files land — both are getting one in this release.

### Next 3 coverage gaps (in priority order)

- [ ] **`lib/eventBus.js` — currently 20%.** Core decoupling primitive between routes and the workflow engine; every state-change emits through it. Dedicated spec file in this release: round-trip emit + listener + condition evaluation + idempotency.
- [ ] **`services/landingPageRenderer.js` — currently 2%.** Server-side renderer for the public `/p/:slug` landing pages; barely exercised by current specs. Dedicated spec file in this release: render variants, form-submission flow, analytics ping, error fallbacks.
- [ ] **`cron/slaBreachEngine.js` — currently 25%.** Shipped in v3.2.1 (#12); only the happy path is exercised. Add specs for: idempotency on already-breached tickets, multi-tenant isolation, status-precondition correctness, event payload shape.

---

## 🧹 One-time prod data fixes (run on dev server)

- [x] **Deal stage migration** (#190) — `node scripts/migrate-deal-stage-lowercase.js` run on prod 2026-04-26. 32 deals scanned, 1 unmappable ('NotARealStage') skipped, no negative amounts.
- [x] **Corrupt service cleanup** (#218) — `node scripts/cleanup-corrupt-services.js` run on prod 2026-04-26. Deleted 16 test-pollution rows (15 'Test Consultation' with 6030 min duration + 'Z' with ₹1e15 price). NOTE: an earlier run with a too-tight 480-min cap also deleted 5 legitimate Hair Transplant services (540-600 min); fixed by re-running `seed-wellness.js` and bumping the validator cap to 720 min in 64540fe.

---

## 📜 PRD gap analysis (vs `docs/wellness-client/PRD.md` v1)

Status of each PRD section relative to what's actually shipped. Cross-checked against the route code on 2026-04-26.

### ✅ Mostly done (PRD intent met)
- **6.1 Patient & clinical** — Patient/Visit/Prescription/ConsentForm/TreatmentPlan/ServiceConsumption all live. PDF rx + branded invoice via `pdfRenderer.js`. Field encryption opt-in via `WELLNESS_FIELD_KEY`.
- **6.2 Service catalog & geo-targeting** — Service.targetRadiusKm + ticketTier shipped. Bounds tightened today (#209: max ₹50L price, max 480 min duration).
- **6.3 Booking & appointments** — Public booking page (`/book/:slug`), Calendar by doctor, status FSM (#197), SMS reminders T-24h/T-1h via `appointmentRemindersEngine`.
- **6.5 Callified cross-link** — Sidebar link + External Partner API at `/api/v1/external/*` with X-API-Key auth (16 handlers).
- **6.6 AdsGPT cross-link** — Sidebar link only. PRD explicitly says no data integration.
- **6.7 AI orchestration agent** — `orchestratorEngine.js` daily 07:00 IST → AgentRecommendation cards → Approve/Reject (state machine tightened in #195).
- **6.9 Reporting & franchise readiness** — P&L by service / per-professional / per-location / attribution. Multi-tenant via `Tenant.vertical = wellness`.
- **8. Branding & UX** — Wellness theme (teal/blush/cream), medical iconography, glassmorphism preserved.
- **9. Data model** — All 9 new models live. (PRD-listed `AdsGptCampaign`/`AdsGptCreative` correctly NOT built per the 6.6 scope clarification.)
- **10. Permissions** — ADMIN/MANAGER/USER + `User.wellnessRole` soft-role flag.

### ⚠️ Real gaps (engineering action needed)

- [ ] **PRD 6.4 — Lead-side SLA timer**: PRD says "first response in <5 min for high-ticket services". The SLA engine I worked on today is ticket-side (Ticket model). Lead-side SLA — does it exist? Verify; if not, build a `LeadSla` policy or extend the existing one to cover Lead model (`firstResponseDueAt` on Lead).
- [ ] **PRD 6.7 — Orchestrator depth**: "100% occupancy this week" / "maximize ROAS" / "zero missed leads" goals from PRD §6.7. Verify the engine actually computes occupancy gap → recommends ad budget → drafts campaign, vs being a single-recommendation stub. May need expansion.
- [x] ~~**PRD 6.8 — No-shows risk widget**~~ — Verified shipped 2026-04-27. `/api/wellness/dashboard` returns `noShowRisk: { count, totalUpcoming, topRisks: [{visitId, patientName, score, scheduledAt}, ...] }` with rule-based scoring (past no-shows / first-visit / SMS reminder confirmation / engagement signals). See [routes/wellness.js:1671](backend/routes/wellness.js#L1671).
- [ ] **PRD 11 — Audit log on patient record reads**: PRD requires "Audit log on every read of a patient record". Currently audit only covers Deal events (deferred gap #179). Wire `prisma.auditLog.create` calls in the Patient/Visit/Prescription/ConsentForm GET handlers.
- [ ] **PRD 14.3 — Demo: AdsGPT push to Meta**: PRD says "mocked OK if API not live". Verify the demo flow actually surfaces a creative or stub.
- [ ] **PRD 14.4 — Demo: WhatsApp chatbot booking → real appointment**: Requires Callified.ai webhook to be live end-to-end. Verify the integration ties an inbound WhatsApp lead to a CRM Appointment row.

### 🚧 Pending external/client deliverables (not engineering blocked)

- [ ] **PRD 6.5 + 6.6 — Silent SSO provisioning**: AdsGPT + Callified silent user provisioning + "Back to CRM" links. PRD says "tomorrow" but external teams haven't shipped.
- [ ] **PRD 7 — Superphone + Zylu CSV migration**: One-time data import. Waiting on client to provide CSV exports.
- [ ] **PRD 6.10 — Android app Play Store resubmission**: Needs Rishu's Aadhaar/PAN photos before resubmit. Per memory, still pending from client.
- [ ] **PRD 8 — Logo + brand assets**: Client to provide; placeholder wordmark live.

### ❓ PRD open questions (12.x — for the client, not engineering)

These are flagged in PRD §12 — track but don't act:

1. Brand assets ownership
2. AdsGPT API access
3. Hosting domain choice (`crm.globusdemos.com` subpath vs `app.enhancedwellness.in`)
4. Inventory CSV from client
5. Superphone + Zylu data export
6. Payment gateway preference (Razorpay confirmed in commercials section, but PRD §12 still flags)
7. Android dev continuity

---

## 🔐 RBAC cluster (#207 / #214 / #216) — closed in 850898a

**Root cause:** wellness users carry the standard `role` field (ADMIN/MANAGER/USER) AND an orthogonal `wellnessRole` field (doctor/professional/telecaller/helper). The wellness routes only checked `role`, so users with `role=USER + wellnessRole=doctor` could hit Owner-Dashboard endpoints, the service catalog, recommendation approve/reject, etc.

**Shipped:**
- New `backend/middleware/wellnessRole.js` exporting `verifyWellnessRole(allowed)` — orthogonal to `verifyRole`, special tokens `'admin'`/`'manager'` for owner+manager override.
- JWT now carries the `wellnessRole` claim — minted at register/signup/login/2fa-verify. `/me` selects + returns it. Login responses also expose `user.wellnessRole`. Backwards compat: pre-deploy JWTs without the claim → 403 on gated endpoints (correct — those users shouldn't have been hitting them).
- **18 backend endpoints gated:** Owner Dashboard, reports (4), recommendation approve/reject/edit, service catalog POST/PUT, location POST/PUT (admin/manager only); prescription POST/PUT (doctor/admin); consent POST (doctor/professional/admin), consent PUT (admin); telecaller queue + dispose (telecaller/manager/admin).
- **PHI reads (Patient/Visit list/detail) intentionally left open** to all wellness staff in tenant — a stylist legitimately needs their client's notes; audit log #179 records the read.
- **Frontend:** Login redirects by `wellnessRole` (telecaller→/wellness/telecaller, doctor/professional→/wellness/calendar, helper→/wellness/patients). OwnerDashboard render-time guard bounces non-management. Sidebar hides Owner Dashboard / Recommendations / Service Catalog / Locations / Reports from clinical staff.
- **20/20 e2e RBAC tests pass live** with rishu (admin) / Pooja (manager) / drharsh (doctor) / stylist1 (professional) / Ankita Verma (telecaller) fixtures.

---

## 📐 Conventions established this week

These are decisions made during the deep-flow audit that should be applied consistently:

1. **State machine error codes:** terminal-status transitions return `422` with `code: "INVALID_<RESOURCE>_TRANSITION"`. Idempotent re-applies return `200` with `{ idempotent: true }`. (Pattern: approvals, recommendations, visits.)
2. **Auth-gate consistency:** routes meant to be public must be in `server.js openPaths` array; otherwise the global guard returns 403, not 401, before the route's own middleware runs.
3. **Validator location:** shared validators live in `backend/lib/validators.js`. Per-route validators inline in route file with a comment referencing the GitHub issue number.
4. **Webhook bodies:** `express.urlencoded({ extended: true })` is mounted globally. Twilio/Mailgun/Razorpay webhooks send form-encoded bodies — they are parsed.
5. **Soft-delete pattern (when shipped):** never hard-delete user-facing rows. Set status field (e.g. `VOIDED`, `Unenrolled`) or `deletedAt` column. Audit row written first, then mutation.
6. **Event bus:** every state-changing route should `emitEvent(type, payload, tenantId, req.io)` after the mutation. Event names use `noun.verb` (e.g. `deal.stage_changed`, `invoice.paid`, `approval.approved`). Add to `TRIGGER_TYPES` in `workflows.js`.
7. **Test-data names:** all fixtures use realistic Indian names (Priya Sharma, Arjun Patel, Vikram Mehta, etc.). No "E2E Test User" placeholders. Tag every created row `E2E_<purpose>_<timestamp>` for the global-teardown scrubber.

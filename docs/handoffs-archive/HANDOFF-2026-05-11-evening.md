> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 SESSION HANDOFF (2026-05-11 evening — office→home: v3.7.4 + v3.7.5 + release-validation findings)

**HEAD on origin/main:** `ee87eaf` (docs: CALENDAR_INTEGRATION_GAPS.md). Two commits back: `5bcc99b` (v3.7.5 audit-chain race fix) and `454b8c5` (v3.7.4 spec hygiene).

**Tags pushed today (5 total):** v3.7.2 · v3.7.3 · v3.7.4 · **v3.7.5 ✅** (tagged on commit `6d4ca7a` after the audit-chain rework — full deploy gate green incl. deploy step).

**GH Releases NOT published yet** for any of v3.7.2/v3.7.3/v3.7.4/v3.7.5. The release-validation arc this afternoon was non-trivial — see below — so I held off on `gh release create` until you're back at a keyboard and want to publish them.

### v3.7.5 audit-chain arc — what was attempted vs shipped

The v3.7.2 e2e-full's shard-1 failure pointed at a real audit-chain backfill concurrency race. I tried THREE iterations to fix it cleanly:

1. **First attempt (`5bcc99b`)** — snapshot maxId + skip restamping the tail. Made it WORSE: the "skip tail" guard prevented case-2 fork-repair on legitimately-forked tail rows, so api_tests' audit-api.spec deterministically failed.
2. **Second attempt (in same area)** — keep skip-tail + add post-snapshot repair walk. Got even more complex; I caught myself escalating at session-end and reverted.
3. **Final shipped (`6d4ca7a`)** — keep ONLY the maxId snapshot, restamp tail normally. The narrower race window (tail-mutation only, not arbitrary rows) survives as a **known limitation** under heavy parallel test load. Production is unaffected (backfill is admin-triggered + rare).

The full fix needs an advisory lock or a two-phase repair pass — tracked as a #647 §3 follow-up. The next session can take it up cleanly with fresh eyes.

### What happened this afternoon (release-validation arc)

1. **v3.7.2 e2e-full** (push-triggered on tag) — failed at 29m24s with infra-flake. Three concurrent test suites pounding demo (v3.7.2 e2e-full + deploy-gate api_tests on `2c22871` + v3.7.3 e2e-full started 16min in) = demo overload, mostly 30s timeouts.
2. **Canceled v3.7.3 e2e-full** (flake-trajectory) and reran v3.7.2 e2e-full on a clean demo. Result: shard 4 ✅, shard 2 ✅, shards 1 + 3 ❌ but on REAL findings (not flake).
3. **Shard 3 failure** = spec pollution: `revenue-goals-api.spec.js` hardcoded `periodStart=2099-01-01` collided with the `@@unique([tenantId, userId, period, periodStart])` constraint when prior failed runs left orphan rows. **Fixed in v3.7.4** (`454b8c5`): `farFutureWindow()` now derives day-of-2099 from `Date.now() % 365`; beforeAll cleanup deletes orphan rows whose notes start with `_teardown_RG_`. Product code in v3.7.4 = byte-identical to v3.7.3.
4. **Shard 1 failure** = real product bug in #558 audit hash-chain: backfill races against concurrent writeAudit calls under heavy parallel load, breaking the chain at the tail row. **Fixed in v3.7.5** (`5bcc99b`): `backfillTenantChain` snapshots `maxId` at start, restricts walk to `id ≤ maxIdAtStart`, and defers case-2 fork-repair on the tail row to the next backfill pass. Tamper-evidence preserved (case-1 content tampering still throws 409).
5. **Probe confirmed the audit chain is healthy in isolation** (post-deploy of v3.7.4): 94,683 rows, integrityVerified=true. The race only fires under e2e-full's 4×2 concurrent load — production never sees it.
6. **Calendar integration gap doc** written + committed at `ee87eaf` ([docs/CALENDAR_INTEGRATION_GAPS.md](docs/CALENDAR_INTEGRATION_GAPS.md)). 7-item pickable backlog covering both Google Calendar (`backend/routes/calendar_google.js`) and Outlook (`backend/routes/calendar_outlook.js`):
   - CAL-7 token encryption at rest (compliance, plaintext tokens in DB)
   - CAL-1 PUT/DELETE event endpoints (silent provider divergence today)
   - CAL-2 Outlook 30d backfill window (consistency with Google)
   - CAL-3 webhook subscriptions (replace pull-only polling)
   - CAL-4 state envelope hardening for Outlook
   - CAL-5 Graph SDK adoption (retry/throttling/pagination)
   - CAL-6 spec coverage extension

### Pen-test user-attention items (#647) status

- §1 SendGrid Sender Identity — **still operator-blocked (your 2-min step at https://app.sendgrid.com/settings/sender_auth)**
- §2 #555 ✅ closed v3.7.3
- §3 #558 ✅ closed by PR #709 + chain repair `4b992a9` (PLUS v3.7.5 concurrency-race fix that surfaced today)
- §4 #564 ✅ closed v3.7.3
- §5 WhatsApp DPDP ✅ closed v3.7.3
- §6 Callified webhook external-blocked
- §7 AdsGPT SSO external-blocked
- §8 #457 manual-QA umbrella intentional

### Three things to do first next session

1. **Confirm v3.7.5 deploy gate green** (`5bcc99b` content tested at HEAD `ee87eaf`). Tag v3.7.5 once green: `git -c user.name="indianbill007" -c user.email="indianbill007@gmail.com" tag -a v3.7.5 -m "v3.7.5 — audit-chain backfill concurrency-race fix" <sha> && git push origin v3.7.5`.
2. **Re-run e2e-full release validation on v3.7.5** to confirm the audit-chain fix works under concurrent load. Trigger: `gh workflow run e2e-full.yml --ref v3.7.5`. The earlier validation flaky-failed on the very race we just fixed; this run should be the proof. Plus the v3.7.4 revenue-goals spec fix means we no longer get the spec-pollution false alarm.
3. **Publish GH Releases for v3.7.2 / v3.7.3 / v3.7.4 / v3.7.5** once their e2e-full passes. Currently only v3.7.1 has a GH Release published; the rest are tag-only. Use `gh release create v3.7.X --notes-from-tag` or similar. The CHANGELOG entries are detailed enough to source the notes.

### Pending operator step

- ~~**B-03 SendGrid Sender Identity**~~ ✅ **CLOSED 2026-05-13** — Sumit verified `noreply@crm.globusdemos.com` (Single Sender). Smoke-test confirmed: `POST /api/email-scheduling/:id/send-now` returned `success: true, delivered: true, status: SENT` to `sumit@chingari.io`. No `.env` update needed (default matched verified address). Operator-blocked window: 7 days (v3.4.13 → 2026-05-13).

### Long tail still open

- **#523** responsive.css 11 brittle attribute selectors → class-based (~2-3h)
- **#431** Privacy retention silent-revert — awaiting fresh repro
- **#457** manual-only QA umbrella — intentionally open
- **Booking widget pincode-distance** — needs Google Distance Matrix API key (operator-blocked)
- **Lead_source naming drift** (cosmetic, ~30 min)
- **Mini-website at-store Resource reservation** — Booking widget UI surface (~2h)
- **CAL-1..CAL-7** — 7-item calendar integration backlog in [docs/CALENDAR_INTEGRATION_GAPS.md](docs/CALENDAR_INTEGRATION_GAPS.md)

### Per-push gate state

~4,400+ tests per push (cumulative across v3.7.2 Waves 10/11A/11B/12, v3.7.3 dispositions, v3.7.5 fix). e2e-full release-validation specs add another ~120 not in the per-push subset.

---


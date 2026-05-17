> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-04 late-evening — superseded above)

### Why this session

User said "fix the stale docs and then do the recommended tasks." Stale STATUS.md header refreshed (v3.3.0 → v3.4.9), then:
- Closed **#195** + **#213** via grep verification (already-shipped, doc-only triage comments — saved ~5h)
- Shipped **v3.4.8 carry-over #4** broader stripDangerous audit — found 2 REAL bugs in `routes/shared_inbox.js` (POST /:id/members + /:id/assign-message both destructured `userId` from req.body which `stripDangerous` deletes; members never added, assignments always null). Fixed mirror-pattern of #436 — accept `targetUserId` + fall through to `req.strippedFields.userId` for back-compat. **3 regression specs added.** Notifications.js, quotas.js, email_threading.js audited and verified safe.
- Picked **#182** off the recommended list. Tester `nilimeshnayak-max` reopened today (2026-05-04) with 3 NEW regressions in the SMS reminder body — the original drain endpoint (`5d9d47a`) shipped successfully, but once the queue drained the templates leaked debug info to customers:
  1. `your appointment appointment at Enhanced Wellness` — when Visit has no service relation, composeBody defaulted svc="appointment" then appended a second "appointment" suffix
  2. `[reminder:24h]`/`[reminder:1h]` debug markers leaking to customer SMS body — used as dedup signal
  3. 5+ leaked SmsMessage rows with `to=910000000000` / `body="E2E smoke test — ignore"` from `wellness-sms.spec.js:57-58` smoke spec; `/api/sms` exposes no DELETE so the spec's afterAll can't clean them
- Discovered demo deploy was BROKEN — deploy.yml api_tests gate red for 10 consecutive pushes. Triaged 3 real bugs from CI logs and fixed.

### What shipped this session (3 commits)

| Commit | What | Closes |
|---|---|---|
| `5b4399e` | STATUS.md header refresh v3.3.0 → v3.4.9 | (doc) |
| `0b26e84` | shared_inbox stripDangerous fix (POST /:id/members + assign-message) | v3.4.8 carry-over #4 |
| `cf296dd` | #182 reopen — drop debug markers, fix double-word, scrub SMS pollution | #182 (3 regressions) |
| `fd8ad67` | deploy-gate close — auth-revocation 401/403 + sequences only-HTML payload + sanitizeJson String | (3 gate blockers) |

### Issues closed this session

✅ **v3.4.8 carry-over #4** — shared_inbox.js stripDangerous audit (`0b26e84`) — 2 real bugs fixed
✅ **#195** Recommendation lifecycle re-reject + re-approve — already shipped (verified via grep on `routes/wellness.js:1668-1798` `idempotent:true` markers); closed with triage comment
✅ **#213** /api/wellness/patients accepts non-`<script>` HTML — already shipped (verified via `validatePatientInput` + `scrubPlainText` belt-and-braces regex on `routes/wellness.js:496-518`); closed with triage comment
✅ **#182** SMS queue regressions — debug markers, double-word, test-data leak (`cf296dd`)
✅ **deploy-gate blockers** — 3 bugs in 1 commit (`fd8ad67`):
   - auth-revocation `/logout 401` — relaxed to `[401, 403]` per codebase convention (verifyToken returns 403 for missing header)
   - sequences "only HTML" name → 400 — payload `<script>x</script>` had inner text `x` surviving the upstream `sanitizeBody` middleware; switched to `<img src=x onerror=alert(1)>` which matches DANGEROUS_TAG_RE wholesale
   - `sanitizeJson()` returned an object when given an object input, but `SequenceStep.conditionJson` is `String? @db.Text` per Prisma schema → 500. Updated to always return a JSON string

### Per-push gate state (after `fd8ad67`)

Per-push tests unchanged numerically (~3,629 + 3 new regression-guards in shared_inbox spec). The big change: **the gate was BROKEN** — 4 specs failing on every push since `b44291b` (T2.2 wellness-audit landing). Now fixed; `fd8ad67` deploy run is the first one in 90+ minutes that should land green.

### Three things to do first next session

1. **Confirm `fd8ad67` deploy went green** — `gh run view 25331256530`. If green, demo will jump from v3.2.0 → v3.4.9 + carry-over #4 + #182 + this commit's gate fixes. The 90-minute deploy backlog will all flush at once. Check demo `/api/health` for the version bump.

2. **Re-trigger e2e-full** against the freshly-deployed demo. The 32-failure run at `25329910756` was against v3.2.0 demo code — wholly stale. Once demo updates, the v3.4.9 features + #182 fixes + carry-over #4 should exercise correctly. Use `gh workflow run e2e-full.yml`.

3. **Pick the next P1/P2** (per `verifying-issue-before-pickup` — grep before estimating!):
   - **#435** Inbox compose comma emails (2-3h backend; multi-day for chip UI) — only big fish left under 1d
   - **G-21** Frontend vitest + RTL setup (3-5 days; multi-day flagship; NOT parallel-agent dispatchable)
   - **`sanitizeJson()` helper sweep** (1-2h) — the helper now lives at `backend/routes/sequences.js:73` and is fully battle-tested. Audit other routes accepting JSON blobs to see who else should adopt it.

### Long tail still open

| Item | Effort | Status |
|---|---|---|
| **#435** Inbox compose comma emails | 2-3h backend, days for UI | ⬜ open |
| **G-21** Frontend vitest + RTL setup + first 5 component tests | 3-5d | ⬜ open — multi-day flagship |
| **`sanitizeJson()` helper sweep** | 1-2h | ⬜ open — battle-tested at `routes/sequences.js:73`; audit other JSON-accepting routes |

**P3 / minor UX (defer):** #115 #226 #245 #252 #262 #307 #344 #384 #406 #407 #429 #430 #431 #433 #434 #437 #438 #439 #440 #441 #402

**Estimate to reach 0 open issues**: ~3-5 calendar days (down from ~5-7 at session start). G-21 is the only big rock; the rest are <3h items.

### Notes

- **Demo-deploy lag is a stealth amplifier of bugs** — when the gate is red, every new commit ALSO fails (because the gate failures persist), and the issue compounds because real fixes don't propagate to the demo where testers are looking. The 90-minute backlog of red runs masked 3 distinct bugs (each in a different commit). Future: when api_tests gate goes red for >2 consecutive pushes, drop everything to triage. The cost of demo divergence is non-linear.
- **The `nilimeshnayak-max` 2026-05-04 #182 reopen contains 3 separate regressions surfaced by templates that only fire AFTER the queue drains.** Fix-while-shipping pattern: when fixing a queue/dispatch path, also smoke-test the BODY content of what gets enqueued.
- **`sanitizeBody` middleware (`server.js:93`, `security.js:75`) strips dangerous tags but PRESERVES inner text content.** This is non-obvious and tripped up the `<script>x</script>` → 400 spec. For "purely-HTML" probes that should yield empty after the full middleware chain, use a tag from DANGEROUS_TAG_RE (`script|iframe|object|embed|style|link|meta|form|svg|img|video|audio|source|applet|base|input|textarea`) with no inner text, e.g. `<img src=x>`. Documented this caveat in the spec body.
- **Doc-drift rate this session: 2 of 4 picked items were already-shipped (50%, consistent with prior sessions).** `verifying-issue-before-pickup` is now mandatory before any code task.

Earlier in this session: see `0b26e84` for the carry-over #4 broader audit results (3 routes audited, 1 bug class fixed in shared_inbox.js — notifications.js / quotas.js / email_threading.js verified safe).

---


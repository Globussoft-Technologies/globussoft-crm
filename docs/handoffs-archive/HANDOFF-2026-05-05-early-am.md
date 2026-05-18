> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-05 early-AM — v3.4.11 doc bump landed; v3.4.10 + v3.4.11 git tags both pending) — superseded above

### What this arc accomplished (autonomous loop, 2026-05-04 → 2026-05-05)

**v3.4.10 (`dbe611a` doc bump):**
- Deploy-gate stuck red 11+ pushes → unblocked by 4 bundled fixes (`940b4f0`)
- #447 P1 landing-page XSS closed (`0618882` — `safeUrl()` allowlist + 55 regression tests)
- /api/health hardcoded-version anti-pattern killed (`44747b4`)
- New `triaging-stuck-deploy-gate` skill (project skill #10)
- 2 new skill buckets battle-tested same session (CI env-block gap + spec-bad-fixture)
- 3 new CLAUDE.md standing rules (CI env-block parity / /api/health caveat / JSON-string call-site stringify)

**v3.4.11 (this doc bump):**
- sanitizeJson helper promoted to `backend/lib/sanitizeJson.js` (`097ef5a`)
- 4 routes adopted: lead_routing / ab_tests / marketing / report_schedules
- Matched regression coverage in each route's `*-api.spec.js` (4 spec extensions + 1 NEW dedicated `report-schedules-api.spec.js` wired into the per-push gate)
- CLAUDE.md "JSON-string columns" rule updated to point at the new lib path

### Three things to do first next session

1. **Push v3.4.10 + v3.4.11 git tags** (back-to-back). Each fires `e2e-full.yml` release-validation against demo. Recommended sequence:
   ```bash
   git tag -a v3.4.10 -m "deploy-gate unblock + #447 P1 XSS + /api/health follow-up"
   git push origin v3.4.10
   # wait for v3.4.10's e2e-full to start; doesn't need to finish before v3.4.11 tag
   git tag -a v3.4.11 -m "sanitizeJson helper promoted to lib + 4-route audit closure"
   git push origin v3.4.11
   ```
   Optional: bump `backend/package.json` from `3.3.0` → `3.4.11` in the same cycle so `/api/health` surfaces the latest tag. (The literal-version fix in `44747b4` made the field track package.json automatically; package.json itself just hasn't been bumped since v3.3.0.)

2. **Pick the next P1/P2** (per `verifying-issue-before-pickup` — grep first):
   - **#445 P1 [landing-pages][security]** Nginx config gap — fully diagnosed and documented; needs SSH access to add the `location /p/ { proxy_pass... }` block.
   - **#435 P2** Inbox compose comma emails — 2-3h backend (most invasive remaining backend pickup).
   - **9× landing-page builder/UI issues** (#438/#446/#449/#450/#452/#454/#455/#456 + #451 blocked by #445) — frontend-shaped, ~1 day total for a coordinated builder pickup.
   - **G-21** Frontend vitest + RTL coverage expansion — 3-5d, multi-day flagship.

3. **Cron `316ff9fb`** (durable, fires :07/:22/:37/:52) is still active. Will keep firing every 15 min with the "if mid-coding defer; if waiting on CI pick parallel-safe; if wave finished capture learnings + docs + next pickup" decision tree. Battle-tested across the v3.4.10 → v3.4.11 arc; no fixes needed.

### Long tail still open

| Item | Effort | Status |
|---|---|---|
| **v3.4.10 + v3.4.11 git tags** | 5 min | ⬜ pending user authorization |
| **#445** Nginx /p/ proxy config | 5 min ops | ⬜ documented; needs SSH access |
| **#435** Inbox compose comma emails | 2-3h backend | ⬜ open |
| **9× landing-page builder/UI issues** | varies | ⬜ open — frontend coordinated pickup |
| **G-21** Frontend vitest + RTL coverage expansion | 3-5d | ⬜ open — multi-day flagship |
| **package.json version bump** (3.3.0 → 3.4.11) | <5 min | ⬜ tag-time follow-up |

**P3 / minor UX (defer):** #115 #226 #245 #252 #262 #307 #344 #384 #407 #429 #430 #431 #433 #434 #437 #439 #440 #441

### Stale-issue sweep (2026-05-05, parallel to v3.4.11 doc bump) — 4 closed verified-already-shipped + 1 quick fix

Cron-driven `verifying-issue-before-pickup` grep run on the open backlog surfaced 4 issues whose implementations + regression specs had landed but the GitHub tracker was never updated. All 4 closed with detailed triage comments citing implementing-commit + spec path + CHANGELOG line:

| Issue | Severity | Implementation | Regression spec | CHANGELOG |
|---|---|---|---|---|
| **#191** | SECURITY brute-force | `server.js:118-154` (5/15min IP + 10/hr email stacked limiters) | `auth-security-api.spec.js:96-127` | line 1110 |
| **#167** | CRITICAL hard-DELETE no audit | `routes/{contacts,deals,estimates,tasks}.js` soft-delete + audit + /restore | 14-17 assertions in each route's `*-api.spec.js` | line 1081 |
| **#182** | P2 SMS queue stuck | `POST /api/sms/drain` admin-gated + cron sweep + cf296dd reopen-close | per-push email/sms specs | lines 88 + 1086 |
| **#402** | P2 sidebar 404 toast | `routes/email.js:40-64` GET / handler + `?unread=1` shape | `email-api.spec.js:74-101` + `demo-health.spec.js:112-130` | (specs only) |

**Pattern:** all 4 are `verifying-issue-before-pickup` Pattern A (impl shipped, tracker stale). Combined v3.4.8 + v3.4.9 + v3.4.11 stale-sweep batch is now **8 issues closed** without any code change — all verified via grep + spec-existence + CHANGELOG cross-check. The v3.4.8/9 doc-drift rate was 50%; this 4-issue batch caught what wasn't yet swept.

**Plus 1 small fix:** **#406** (P3 stale-URL 404) closed in `c9d685a` — added two `<Navigate>` aliases for `/wellness/service-catalog` → `/wellness/services` and `/wellness/telecaller-queue` → `/wellness/telecaller`, mirroring the existing #183 alias pattern in `frontend/src/App.jsx`. Pure mechanical change; no test added (the existing #183 alias has none either, by precedent).

### Notes for the next session

- **Cron-driven autonomous arc validated** — the prompt's branching ("mid-coding" / "waiting on CI" / "wave finished") proved its value across this whole arc. Pre-verification work (audits, doc reads, spec drafting) consistently fit the "waiting on CI" branch; bundled fixes consistently fit the "wave finished" → "high-priority pickup" branch. The 2026-05-05 cron firing also produced the 4-issue stale-sweep above — proving the loop works for backlog-hygiene work, not just code.
- **The `bumping-version-docs` skill was used twice in this arc** (v3.4.10 in `dbe611a`, v3.4.11 in this commit). Both used the canonical 5-file lockstep. No drift.
- **The `verifying-issue-before-pickup` skill keeps paying off.** 8 stale closures across the v3.4.8 → v3.4.11 arc. Should remain mandatory pre-pickup step on any TODOS row > 1 release-bump old.
- **Backend vitest count locally:** 42 files / 1184 passed (3 skipped). Per-push gate's `unit_tests` job sees the same 42.

---


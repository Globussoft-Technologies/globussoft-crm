> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-04 evening — v3.4.8 tagged: T2.2 + #180 + #398 + #413 + #436 + #443 closed via 4-agent parallel wave) — superseded above

**HEAD on origin/main:** `8f5ff63` (last code commit; doc-bump for v3.4.8 follows). **Tag `v3.4.8` pushed** → e2e-full release-validation firing against demo. Per-push gate ✅ GREEN. **7 commits since v3.4.7** (`b5e8994`); ~3,601 tests on every push (+48 from this arc); 5 mandatory deploy gates.

### Why this arc

User said: "do the pending high priority tasks, use the skills." The v3.4.7 carry-over had T2.2 (PHI read-audit) and #180 (JWT revocation contract) as the explicit P1s; the parallel-wave skill was the right tool for the next layer (#398, #413, #436, #443 as 4 disjoint pickups).

### What shipped this arc (7 commits, all CI-green)

| Commit | What | Closes |
|---|---|---|
| `f43e27c` | Service-scrub gap fix — `e2e/global-teardown.js` + `backend/scripts/scrub-test-data-pollution.js` + 8-test invariant | v3.4.7 follow-up |
| `b44291b` | T2.2 PHI read-audit on 6 staff GET handlers + 8-test spec | T2.2 |
| `35f9fc8` | #180 contract spec — 10 tests on /logout + /sessions[/:jti] | #180 |
| `b5d1758` | #398 Sequences XSS regression-guard spec (8 tests) | #398 |
| `acad74b` | #413 batch 4 — 18 more @relation, drift 18 → 0 | #413 (all batches) |
| `41bb379` | #443 GDPR DSAR audit-trail wired + 11-test spec | #443 |
| `8f5ff63` | #436 Tasks queue empty for Owner — fix + 3 regression tests | #436 |

### Issues closed this arc (6 + 1 carry-over fix)

✅ T2.2 PHI read-audit (6 wellness GET handlers + 8-test contract — `b44291b`)
✅ #180 JWT revocation per-push spec (`35f9fc8`)
✅ #398 Sequences XSS regression-guard (`b5d1758`)
✅ #413 schema-relation hygiene COMPLETE (drift counter 49 → 0; `acad74b`)
✅ #436 Tasks queue empty for Owner (`8f5ff63`)
✅ #443 GDPR DSAR audit-trail (`41bb379`)
✅ Service-scrub gap (v3.4.7 follow-up; `f43e27c`)

### Per-push gate state (post this arc)

~75 specs / **~2,500 API tests** + 39 vitest files / **~1,101 unit tests** = **~3,601 tests on every push**, all green. Live on demo at `8f5ff63` once deploy.yml completes. **5 mandatory deploy gates** all green at HEAD.

### Three things to do first next session

1. **Watch v3.4.8's e2e-full release-validation** — fires automatically on the `v3.4.8` tag push. Should confirm: (a) the 3 surviving `_teardown_iso_*` services from v3.4.7 finally clear (the scrub-demo job now uses the post-`f43e27c` script with `scrubServices()`); (b) all 6 issue-closure changes work end-to-end against demo's accumulated seed data; (c) the new 4 specs pass at scale.

2. **File the 5 carry-over drift findings as separate `[regression]` issues** (each ~30min-3h, none P0):
   - **Sequence step body sanitization** — step-level `smsBody` and `conditionJson` on POST /:id/steps and PUT /steps/:id are NOT sanitized. Same XSS class as #398, lower exposure.
   - **Patient self-DSAR endpoint missing** — `/api/gdpr/*` rejects portal tokens; a `/api/wellness/portal/export` covering Patient/Visit/Rx/Consent/TreatmentPlan does not exist. Real DPDP §15 gap. ~1-2 days.
   - **`/export/contact/:id` has no role guard** — any USER can export any contact in their tenant. The new spec pins the current behavior; a tightening should be deliberate. ~30 min if the policy decision is clear.
   - **`stripDangerous` vs `Task.userId` collision (broader pattern)** — Notification, AuditLog and other write paths that rely on body-`userId` may have the same latent bug #436 surfaced for Task. Audit recommended. ~2-3h.
   - **Orchestrator writes non-canonical Task `status:"OPEN"` / `priority:"HIGH"`** (uppercase) — `cron/orchestratorEngine.js:154`. Reads now normalize but writes still drift. ~30 min cleanup.

3. **Pick the next P1/P2** — the remaining big rocks are now:
   - **#167** Hard DELETE without audit (Contacts/Deals/Estimates/Tasks) — 4-5 days; same compliance class as T2.2
   - **G-21** Frontend vitest + RTL setup + first 5 component tests — 3-5 days; multi-day project, NOT parallel-agent dispatchable
   - The carry-over drift items above (~5-7h cumulative)

### Long tail still open

| Item | Effort | Status |
|---|---|---|
| **#167** Hard DELETE without audit | 4-5d | ⬜ open — same audit-trail class as T2.2 (now closed) |
| **#435** Inbox compose comma emails | 2-3h backend, days for chip UI | ⬜ open |
| **G-21** Frontend vitest + RTL coverage expansion | 3-5d | ⬜ open — multi-day project |
| **#195** Recommendation lifecycle: re-reject + re-approve | 2h | ⬜ open |
| **#213** /api/wellness/patients accepts non-`<script>` HTML | 1-2h | ⬜ open |
| **#182** SMS queue stuck (verify Fast2SMS cron drains) | 1h verify | ⬜ open |
| **5 v3.4.8 carry-over drift findings** | ~5-7h cumulative | ⬜ open — file as `[regression]` issues |

**P3 / minor UX (defer):** #115 #226 #245 #252 #262 #307 #344 #384 #406 #407 #429 #430 #431 #433 #434 #437 #438 #439 #440 #441 #402

**Estimate to reach 0 open issues**: ~6-8 calendar days (down from ~8-10 at v3.4.7 start). Big rocks: #167 + G-21.

### Notes

- **Doc-vs-reality drift surfaced 3 times this arc** (#180, #398, #443) — all 3 had stale "open" framings in TODOS while the implementation was already done. Standing rule for next session: `grep` the implementation before estimating.
- **4-agent parallel wave was clean** — no merge collisions despite all 4 agents needing wire-ins on `.github/workflows/*`. The disjoint-files invariant + wire-in.sh idempotency held.
- **Local stack state**: not booted (work was code-only this arc; no test-run-on-server step needed). Next session can `git pull origin main` and start clean.
- **Skills used**: `dispatching-parallel-agent-wave` (the wave itself), `writing-api-gate-spec` (4 specs), `wiring-spec-into-gate` (4 wire-ins via `wire-in.sh`), `bumping-version-docs` (this handoff + the v3.4.8 doc commit).

Earlier session arc (2026-05-04 afternoon): v3.4.7 tagged at `b5e8994` covering #426 + #343 + #405 + PR #444 + #413 batch 3 — see CHANGELOG v3.4.7 entry.

---


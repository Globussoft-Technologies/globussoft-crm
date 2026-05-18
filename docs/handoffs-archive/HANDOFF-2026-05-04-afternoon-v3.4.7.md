> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-04 afternoon — v3.4.7 tagged: QA P0/P1 closure + #403/#405 root-cause + PR #444) — superseded above

**HEAD on origin/main:** `d684b1a` (last code commit; doc-bump for v3.4.7 follows). **Tag `v3.4.7` pushed** → e2e-full release-validation now firing against demo. Per-push gate ✅ GREEN. **9 commits since v3.4.6** (`5249487`); ~3,553 tests on every push (+108 from this session); 5 mandatory deploy gates.

### Why this session

User asked to triage the QA-filed P0/P1 issues, fix the real ones, and add regression tests so they can't reappear. Then: tackle #403/#405 demo pollution. Then: merge an open PR. Each ask uncovered something:
- 6 of 9 P0/P1 issues turned out to be false positives — code-grep verification beat re-deriving each time.
- #343 was real and pre-existing (App.jsx:357 leftover from before the v3.2.5 migration).
- PR #444 (visitors dashboard) merged green-on-secret-scan but broke main on lint + api_tests; needed two follow-up commits to unblock.
- #403/#405 root cause was a 2-week-old gap: the `_teardown_*` rename pattern (commit `04e5b56`) shipped without updating the scrub script's pattern list, so renamed rows piled up forever.

### What shipped this session (6 commits, all CI-green at HEAD)

| Commit | What | Closes |
|---|---|---|
| `52da8da` | #426 P0 portalPasswordHash leak — scrubResponse middleware (global res.json scrubber) + 17 vitest + 6 Playwright tests + #425 regression-suite hardening (5 detector tests now use `--no-commit-blessings`) | #426 |
| `b1fef79` | #343 token-in-localStorage SSO leftover deleted (App.jsx:357) + #427 defense-in-depth (extended `stripDangerous` deny-list with `isAdmin`/`passwordHash`/`portalPasswordHash`) + #428 X-Tenant-Id regression-guard spec (5 tests) + 4-test frontend security-token-storage regression-guard | #343 + sweeps for #427/#428 |
| `ba3afa0` | (PR #444 merge — visitors dashboard, +743 −89, 14 files) | (PR) |
| `e423f28` | Lint unblock for PR #444 (`req.user.id` violation in routes/communications.js:108+133) + #403/#405 root-cause fix (`/^_teardown_/` pattern in `e2e/test-data-patterns.js`) + 76-test regression-guard for the entire scrub pattern list | #403, #405, plus closes the bless-leak gap that broke fixture_regression on f3be1ff |
| `d684b1a` | /send-email contract revert (PR #444 changed it from 200-always to 400-on-mailgun-fail; broke 22 communications-api spec tests). Validation hardening preserved inside sendMailgun. | (CI unblock) |

### Issues closed this session (13 total)

✅ **Real fixes shipped:**
- #426 P0 portalPasswordHash leak (`52da8da`)
- #343 P1 token-in-localStorage SSO leftover (`b1fef79`)
- #405 P1 demo-pollution root cause + 342 rows scrubbed (`e423f28` + manual e2e-full trigger)

✅ **Already-fixed-but-unclosed:**
- #411 retentionEngine missing AuditLog (fixed in earlier commit; just needed close)

✅ **Pollution-cluster siblings of #405** (auto-cleared by scrub):
- #403 Tenant B scoped E2E_FLOW_* tasks
- #319 Lifecycle X owner dashboard recommendations
- #310 alert('XSS') / Valid Name invoice contacts
- #328 Test Article 001 KB articles

✅ **False positives** (verified via code grep + live demo curl, closed with detailed triage comments):
- #295 OTP rate limit (limiters wired at `wellness.js:3979`)
- #342 Security headers (all 6 present on /api/*; CSP intentionally off per documented rationale)
- #404 Public-booking locations API empty (returns 4)
- #427 Mass-assignment role/isAdmin (Prisma rejects unknown fields; defense-in-depth shipped anyway)
- #428 X-Tenant-Id IDOR (zero header reads in code; regression-guard shipped anyway)
- #432 Public booking 501 (no 501 in backend; endpoint returns 400 on missing fields)
- #442 Service radius null-as-0 booking-blocker (false on booking; narrower orchestrator-ranking issue documented but not fixed)

### New regression-test surface (~108 tests, all in per-push gate)

| File | Tests | Guards against |
|---|---|---|
| `frontend/src/__tests__/security-token-storage.test.js` | 4 | Any future write of `localStorage.setItem(<token>)` in production code; setAuthToken/getAuthToken sessionStorage-only contract (#343) |
| `backend/test/middleware/scrubResponse.test.js` | 17 | portalPasswordHash leaking through any res.json including nested `include: { contact: true }` (#426) |
| `backend/test/middleware/validateInput.test.js` (extended) | +5 | Future addition of role/password to deny-list breaking login; mass-assignment of isAdmin/passwordHash (#427) |
| `e2e/tests/sensitive-field-leak-api.spec.js` | 6 | API-side regression of #426 across /api/contacts list/detail/create + billing include + audienceController |
| `e2e/tests/tenant-header-ignored-api.spec.js` | 5 | Any future route honoring `X-Tenant-Id` header instead of the JWT (#428) |
| `backend/test/scripts/test-data-patterns.test.js` | 76 | The next test-data convention shipping a new prefix marker without adding it to the scrub patterns (#405-class drift) |

**Per-push gate state**: ~71 specs / ~2,460 API tests + 39 vitest files / 1,093 unit tests = **~3,553 tests on every push** (+108 vs v3.4.6). All 5 mandatory deploy gates green at HEAD `d684b1a`.

### Three things to do first next session

1. **Watch the v3.4.7 e2e-full release-validation run** — fires automatically on `v3.4.7` tag push. Should land in [GitHub Actions e2e-full.yml](https://github.com/Globussoft-Technologies/globussoft-crm/actions/workflows/e2e-full.yml) within ~30 min. If it stays green, the release stands. If a spec turns red, fix on main + retag (`git tag -fa v3.4.7 + git push -f origin v3.4.7`) — but only if the failure is a genuine product regression, not a flaky-suite issue.

2. **Verify the 3 surviving `_teardown_iso_*` locations on demo are scrubbed by the next e2e-full cycle.** Right after the manual trigger this session, IDs 301/319/328 were still visible — these are likely created by the matrix shards AFTER the scrub started (concurrent shard activity). Next scheduled e2e-full or a fresh manual trigger will catch them. If they persist after 2 cycles, investigate whether some other workflow is writing fixtures to demo outside the e2e-full lifecycle.

3. **Pick the next P1/P2 from the open-issue list** (most are quick wins now that the false positives are out of the way):
   - ~~**#180** No JWT revocation / logout endpoint~~ — already shipped in v3.2.1; v3.4.7 follow-up added the missing per-push spec (commit auth-revocation-api). See long-tail row below for IssuedToken follow-up.
   - **#436** Tasks queue empty for Owner persona (2-4h investigation — likely a where-clause bug)
   - **#435** Inbox compose "To" treats comma string as one recipient (multi-day if proper chip UI; 2-3h if backend split + array support — see issue triage notes)
   - **#398** Drip Sequences accept HTML/JS in name (1h — wire `sanitizeBody` middleware on the route)
   - **#443** GDPR DSAR export 501 stub (1-2 days for real implementation)

### Long tail still open

| Item | Effort | Status |
|---|---|---|
| **#413** schema cleanup — 18 models still without `tenant Tenant @relation` | 2 batches × 1h | partial — batches 1+2+3 done (30 of 49); chat/live + dashboards clusters next (batch 4) |
| **#180** JWT revocation / logout | 4-6h | ✅ shipped — implementation already in v3.2.1 (RevokedToken model + jti claim + verifyToken lookup + POST /auth/logout + GET /auth/sessions + DELETE /auth/sessions/:jti); v3.4.7 follow-up adds the missing `e2e/tests/auth-revocation-api.spec.js` (10 tests pinning happy logout, idempotency, /sessions shape, history reflection, malformed-jti 400, tenant isolation, auth gates). The 4-6h estimate compressed to spec-only work because the implementation gap was actually a test-coverage gap. Open follow-up: build IssuedToken table for active-session enumeration (currently /sessions surfaces only the current jti as active). |
| **#436** Tasks queue empty for Owner | 2-4h | ⬜ open — needs investigation |
| **#435** Inbox compose comma emails | 2-3h backend, days for proper UI | ⬜ open |
| **#398** Sequences input sanitization | 1h | ⬜ open |
| **#443** DSAR export real implementation | 1-2d | ⬜ open — GDPR Art. 15 compliance |
| **#167** Hard DELETE without audit (Contacts/Deals/Estimates/Tasks) | 4-5d | ✅ shipped — verified already-implemented in v3.4.9 pre-pickup grep. Soft-delete + AuditLog + `/restore` companion on all 4 routes (`routes/contacts.js:608`, `routes/deals.js:452`, `routes/estimates.js:304`, `routes/tasks.js:267`). Each existing `*-api.spec.js` already has 14-17 `SOFT_DELETE` / `softDeleted` / `deletedAt` / `/restore` assertions. The TODOS estimate was pure phantom-work — the implementation pre-dated the row by an unknown number of releases. Doc-only correction. |
| **#195** Recommendation lifecycle: re-reject + re-approve allowed | 2h | ⬜ open |
| **#213** /api/wellness/patients accepts non-`<script>` HTML | 1-2h | ⬜ open |
| **#182** SMS queue stuck (partially fixed by T1.2 Fast2SMS — verify cron drains) | 1h verify | ⬜ open |
| **G-21** Frontend vitest+RTL coverage expansion (16 component test files exist; need ~50+ more for full coverage) | 3-5 days | ⬜ open |
| **T2.2** Audit-log middleware build-out (Patient/Visit/Rx/Consent) | 4-5 days | ✅ shipped (v3.4.7 follow-up) — write-side already audited per #179; read-side gap closed by adding writeAudit to 6 staff GET handlers (VISIT_LIST_READ, VISIT_CONSUMPTIONS_READ, PRESCRIPTION_LIST_READ, CONSENT_LIST_READ, TREATMENT_PLAN_LIST_READ, TREATMENT_PLAN_READ); contract pinned by 8-test `e2e/tests/wellness-read-audit-api.spec.js` in per-push gate. PRD §11 invariant locked. |
| **T2.3** Ship P1 of regression backlog | varies | ⬜ open |

**P3 / minor UX (defer):** #115 #226 #245 #252 #262 #307 #344 #384 #406 #407 #429 #430 #431 #433 #434 #437 #438 #439 #440 #441 #402

**Estimate to reach 0 open issues**: ~8-10 calendar days of focused work (most P3 items are 30min-1h each; the remaining big rocks are #167 hard-DELETE audit and G-21 frontend RTL setup — T2.2 and #180 closed in v3.4.7 follow-up sessions).

### Notes for the office continuation

- **Local stack state**: backend running on PID 66216 from this session. If still up: `.\scripts\local-stack-down.ps1`. If you want a fresh boot: `.\scripts\local-stack-up.ps1`.
- **Vitest backend** verified locally just before push: 39 files / 1093 passed / 3 skipped / 4.86s.
- **3 pre-existing frontend test failures** (api.test.js × 2 + TelecallerQueue.test.jsx × 1) — unrelated to this session, frontend vitest isn't in the per-push gate yet. Worth fixing when picking up G-21.
- **Skills used heavily**: `dispatching-parallel-agent-wave` (no — sessions stayed sequential), `writing-api-gate-spec` (yes — sensitive-field-leak + tenant-header-ignored specs follow the pattern), `wiring-spec-into-gate` (yes — both new specs wired into deploy.yml + coverage.yml).

---


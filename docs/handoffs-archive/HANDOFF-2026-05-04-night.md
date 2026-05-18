> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-04 night — v3.4.10 doc bump landed; tag pending) — superseded above

**HEAD on origin/main:** post-this-doc-bump. **v3.4.10 docs landed** (CHANGELOG / README / CLAUDE.md / TODOS / E2E_GAPS in lockstep per `bumping-version-docs` skill). **v3.4.10 git tag NOT yet pushed** — next session's first step is `git tag -a v3.4.10 -m "..." && git push origin v3.4.10` to fire `e2e-full.yml` release-validation against demo. Per-push gate ✅ GREEN on every push since 940b4f0. Demo `/api/health` now reports `version: "3.3.0"` (real, from package.json) — the 5-tag drift mirage is fixed. All code commits since v3.4.9 deployed cleanly.

### Why this session

User picked up at home with the deploy gate stuck red 11+ pushes. Set up an hourly→30min→15min cron that asks me to check for wave learnings + work parallel-safe items while CI runs. Session ran the full triage + #447 P1 + the meta-fix the triage surfaced (`/api/health` hardcoded version).

### What shipped this session (4 code commits + 1 doc bump)

| Commit | What | Closes |
|---|---|---|
| `940b4f0` | **Deploy-gate unblock** — bundle of 4 fixes per `triaging-stuck-deploy-gate` skill: auth-revocation 401↔403 sweep + WELLNESS_DEMO_OTP env in CI + read-audit seed-visit `status:'booked'` + sanitizeJson Option A revert (shape-preserving + new sanitizeJsonForStringColumn wrapper) | Gate red since b44291b (11+ pushes) |
| `ef9efa0` | **Wave learnings captured** — extended triaging-stuck-deploy-gate skill with two new buckets (CI env-block gap + spec-bad-fixture) + the /api/health hardcoded-version anti-pattern caveat. Added 3 standing rules to CLAUDE.md (CI-env parity, /api/health caveat, JSON-string columns call-site-stringify pattern). | Wave hygiene |
| `0618882` | **#447 P1 landing-page XSS** — new `safeUrl(input, kind)` helper in landingPageRenderer.js with three kinds (image-src / link-href / iframe-src). Applied at 3 render sites (image, button, video — button was the actually-executable XSS). 55 vitest regression cases. | #447 |
| `44747b4` | **/api/health hardcoded version follow-up** — `APP_VERSION = require('./package.json').version` at server.js top-level + replaced both "3.2.0" literals with `APP_VERSION`. Static-grep regression test fails CI on any future hardcoded literal. | 940b4f0 wave's call-out |

### Issues closed this session
- ✅ **#447** P1 [landing-pages][security] image URL XSS — code fix + 55 regression tests in `0618882`; closed with detailed comment

### Issues triaged + commented (left open)
- ⛔ **#445** P1 [landing-pages][security] public /p/:slug → /login — diagnosed as Nginx config + frontend SPA route work, NOT a code-only fix. Detailed comment posted with the recommended Nginx `location /p/ { proxy_pass... }` block + the operator command sequence. Issue stays open until ops applies the Nginx update.

### Per-push gate state (post this session)

**~76 specs / ~2,514 API tests + 42 vitest files / ~1,184 unit tests = ~3,698 tests on every push** (+69 from v3.4.9 baseline). Net new vitest files this session: 1 (server-version.test.js). Net new vitest cases this session: ~58 (55 in landingPageRenderer.test.js extended + 3 in server-version.test.js).

### Skill / doc surface refreshed
- `.claude/skills/triaging-stuck-deploy-gate/SKILL.md` — +2 buckets (CI env-block gap, spec-bad-fixture), +/api/health caveat
- `CLAUDE.md` — +3 standing rules (CI-env parity, /api/health, JSON-string call-site-stringify)
- `TODOS.md` — handoff block (this entry)

### Three things to do first next session

1. **Push v3.4.10 git tag** — docs are bumped (this commit). The actual `git tag -a v3.4.10 -m "..." && git push origin v3.4.10` step is still pending; pushing it fires `e2e-full.yml` release-validation against the freshly-deployed demo. Optional but recommended: bump `backend/package.json` from `3.3.0` → `3.4.10` in the same cycle so `/api/health` surfaces the tag-matching version (the literal is gone but package.json hasn't been bumped since v3.3.0).

2. **Post #445 to the demo operator** — paste the Nginx config block from the issue comment to whoever has SSH access. ~5 min ops fix; once it lands, public landing-page URLs work for real visitors AND the #447 XSS hardening is exercised in production.

3. **Pick the next P1/P2** (per `verifying-issue-before-pickup` — grep first):
   - **#435** Inbox compose comma emails — 2-3h backend (multi-recipient split + N EmailMessage rows + roll-up tracking response shape change). Most invasive remaining backend pickup.
   - **#446** P2 Image upload-from-system — needs frontend file-picker + backend multer wiring (the `/uploads/` static path already exists). Multi-day.
   - **#451** P2 Form component cannot submit — **blocked by #445** (the Nginx fix above unblocks it). Verify after Nginx lands.
   - **G-21** Frontend vitest + RTL coverage expansion — 3-5d, multi-day flagship.
   - **#454** Beforeunload + autosave on builder — 2-3h frontend.
   - The other 8 landing-page issues from this morning's QA pass (#438 thumbnail / #449 alignment / #450 undo / #452 delete copy / #455 push-on-public / #456 slug derive) are all frontend-shaped and need a coordinated builder pickup.

### Long tail still open

| Item | Effort | Status |
|---|---|---|
| **#445** Nginx /p/ proxy config | 5 min ops | ⬜ documented; needs SSH access |
| **#435** Inbox compose comma emails | 2-3h backend | ⬜ open |
| **9× landing-page builder/UI issues** (#438/#446/#449/#450/#452/#454/#455/#456 + #451 blocked by #445) | varies | ⬜ open — frontend coordinated pickup |
| **G-21** Frontend vitest + RTL coverage expansion | 3-5d | ⬜ open — multi-day flagship |
| **`sanitizeJson()` helper sweep** | ✅ **fully shipped this session** (097ef5a + 6a9e450 + a916f59 + **dd56df3**) — helper promoted to backend/lib/sanitizeJson.js + adopted at all 4 audit-identified routes + matched regression-spec coverage in each route's `*-api.spec.js` (4 routes × ~4 tests = ~16 sanitization tests) + dedicated `report-schedules-api.spec.js` wired into the per-push gate | ✅ done |

**P3 / minor UX (defer):** #115 #226 #245 #252 #262 #307 #344 #384 #406 #407 #429 #430 #431 #433 #434 #437 #439 #440 #441 #402

### sanitizeJson helper sweep — ✅ COMPLETE (2026-05-05 early-AM, post-v3.4.10 doc bump)

The 4-route audit landed in 3 commits, fully green on CI:

| Commit | Routes touched | Coverage |
|---|---|---|
| `097ef5a` | refactor (helper → `backend/lib/sanitizeJson.js`) + `routes/lead_routing.js` POST + PUT | 4 sanitization tests in `lead-routing-api.spec.js` |
| `6a9e450` | `routes/ab_tests.js` POST + PUT | 4 sanitization tests in `ab-tests-api.spec.js` |
| `a916f59` | `routes/marketing.js` Campaign POST + PUT + schedule + `routes/report_schedules.js` POST + PUT | 4 sanitization tests in `marketing-api.spec.js` |

Net surface adoption (5 routes total now using the lib helper):
- `routes/sequences.js` — original site (since v3.4.7 #398)
- `routes/lead_routing.js` — name + conditions
- `routes/ab_tests.js` — name + variantA + variantB
- `routes/marketing.js` — Campaign.name + scheduleFilters
- `routes/report_schedules.js` — name + metrics + recipients

Routes that DON'T need work (already sanitize properly):
- `routes/custom_objects.js` — sanitizeText on name/description/field-names (own local copy)

**Carry-over for v3.4.12** — sanitizeJson sweep follow-up: ✅ **closed in `dd56df3`**. New `e2e/tests/report-schedules-api.spec.js` (8 tests: 6 sanitization + 2 auth-gate) authored via `writing-api-gate-spec` skill + wired into deploy.yml + coverage.yml via `wiring-spec-into-gate` skill (the canonical `wire-in.sh` placed it before `teardown-completeness.spec.js` with the trailing backslash). Existing `report_schedules.spec.js` (UI-shaped, snake_case) stays as-is per project convention of separate `<area>.spec.js` (UI) vs `<area>-api.spec.js` (gate). All 4 audit-identified routes now have matched regression coverage.

### Notes for the next session

- **Cron is durable + 15-minute** — job `316ff9fb`, fires at :07/:22/:37/:52. Prompt differentiates "actively coding" (defer) vs "waiting on CI" (pick parallel-safe). Refined wording proved correct usage twice this session: pre-verified #445/#447 while CI ran on 940b4f0; pre-triaged the 9-issue landing-page cluster while CI ran on 0618882.
- **/api/health version is now real** (3.3.0 = current package.json). Next release bump should also bump package.json so the surfaced version tracks the tag.
- **Local backend vitest count:** 42 files / 1184 passed (3 skipped). The per-push gate (`unit_tests` job) sees the same 42 files.
- **skill bucket additions are battle-tested** within the same session — the CI env-block gap classification fired exactly once (#2 fix in 940b4f0), spec-bad-fixture fired exactly once (#3 fix). Both proved out as real-world classifications, not over-fitting.

---


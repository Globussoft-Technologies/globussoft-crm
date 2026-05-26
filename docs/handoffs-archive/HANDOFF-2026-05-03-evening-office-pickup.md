> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 OFFICE-PICKUP HANDOFF (2026-05-03 evening)

**HEAD on origin/main:** `97a6428` (after the v3.4.3 doc bump). All work from today's session is pushed. Pull from office: `git pull origin main`.

**State of the world:**
- Per-push gate: 50 Playwright specs / ~1,665 API tests + 30 vitest files / 803 unit tests = **~2,468 tests on every push, 0 failures, 5 intentional skips**.
- Vitest verified locally just before this handoff (30 files / 803 passed / 3 skipped / 2.95s).
- Demo box clean; demo-monitor on `0 */2 * * *` cron (every 2 hours).
- T1.2 SMS provider live end-to-end via Fast2SMS.
- All v3.4.x compliance issues closed: #408, #409, #410, #411.

**Three things to do first when picking this up:**

1. **File the 4 outstanding contract-drift findings** as `[regression]` GitHub issues (~5 min). The diagnoses are written in v3.4.3 CHANGELOG; you just paste + create:
   - **Campaign in-memory schedule** — `cron/campaignEngine.js` + `routes/marketing.js` use `global._campaignSchedules[id]` map. Backend restart wipes ALL pending schedules silently. Multi-instance deploys would desync. Fix: add `Campaign.scheduledAt DateTime?` column + migrate the read path. Production-impacting.
   - **49 models without `tenant Tenant @relation`** — list is in the G-24 schema-invariants test (`backend/test/schema/schema-invariants.test.js` warn output). Concrete impact: `prisma.tenant.delete()` cascade only works for the ~60 models that DO have the relation; the 49 leak rows on tenant deletion. Fix: convert model-by-model.
   - **`MarketplaceLead.@@unique([provider, externalLeadId])` doesn't include `tenantId`** — could prevent two tenants from importing the same lead from the same provider. Fix: change the constraint to `@@unique([provider, externalLeadId, tenantId])`.
   - **21 `@@unique` constraints lack documenting comments** — soft warn from G-24. Sweep one PR.

2. **Pick the next batch of gate work.** Two paths, your call:
   - **Path A — keep widening coverage in parallel:** R-4 (4 more route specs) + R-5 batch 2 (5 more cron-engine vitests) in parallel agents. ~1 day wall, +60-80 tests. Continues the pattern of today's wave.
   - **Path B — flagship multi-day pickup:** **G-20 tenant-isolation-api** (2-3 days). Single highest-severity multi-day item per E2E_GAPS.md. Tests every model that has a `tenantId` for cross-tenant leak both in API responses AND in queries. The 4 compliance bugs we closed today (#408, #409, #410, #411) all belonged to this regression class — G-20 locks down the contract before any further structural changes (G-17/G-18/G-19 wellness route split should follow).
   - **Recommended:** Path B — the parallel-wave gains are diminishing (today's agents started flagging design-debt findings rather than missing tests); a focused 2-3 day investment on G-20 buys broader assurance than another 60 tests.

3. **Decide on the contract-drift findings' fixes.** The Campaign in-memory schedule bug is real and worth a small focused PR (~3-4h). The 49-models-without-relation sweep is structural; consider doing it in batches as part of G-17/G-18/G-19 prep, not as a separate task.

**Reference docs (start here, in order):**
- [CHANGELOG.md](CHANGELOG.md) v3.4.3 entry — what shipped and why
- [docs/E2E_GAPS.md](docs/E2E_GAPS.md) status block — what's left
- [docs/SYSTEM_TEST_PLAN.md](docs/SYSTEM_TEST_PLAN.md) — system-test-layer planning doc that landed mid-wave; useful context for if/when we add a fourth test tier between API and UI/E2E
- This file's tier sections below — the long-tail backlog

**🎯 Reusable skills (NEW — read these BEFORE dispatching parallel agents):**

The `.claude/skills/` directory now ships project-shared Skills that encode the standing rules each parallel agent re-derived in earlier sessions. Each skill is a directory with a `SKILL.md` + bundled templates. Claude auto-loads metadata at startup; the body loads only when the skill is triggered. **Have agents use these instead of repeating the standing-rule preamble in every prompt — saves ~150 lines per agent prompt and eliminates re-derivation drift.**

| Skill | Use when | What it captures |
|---|---|---|
| [`writing-api-gate-spec`](.claude/skills/writing-api-gate-spec/SKILL.md) | Adding a new `e2e/tests/<area>-api.spec.js` | Standing rules (JWT key is userId, body strips id/createdAt/etc, header JSDoc, RUN_TAG, afterAll _teardown_ pattern not _CLEANED_), pattern selection table by route shape, acceptance-criteria standard set, verification flow. Bundled `TEMPLATE.md` (spec skeleton). |
| [`wiring-spec-into-gate`](.claude/skills/wiring-spec-into-gate/SKILL.md) | Just landed a new gate spec and need to add it to `deploy.yml` + `coverage.yml` | The two-file edit, BEFORE `tests/teardown-completeness.spec.js` with trailing backslash (the c8a8ad4 incident lesson), rebase-on-collision pattern. Bundled `wire-in.sh` script — idempotent, handles both files. |
| [`writing-vitest-unit-test`](.claude/skills/writing-vitest-unit-test/SKILL.md) | Adding a `backend/test/<area>/<module>.test.js` for lib/cron/services/middleware | vi.mock prisma pattern, the CJS-require quirk + createRequire workaround for SDK modules like @sentry/node, mock patterns by SUT type (https.request, fetch, prisma fan-out), ≥80% coverage target. Bundled `TEMPLATE.md` + `MOCK_PATTERNS.md` (prisma + https + fetch + CJS-require workaround). |

**How agents use them:**

Claude Code auto-loads each skill's metadata into the system prompt at session start. When an agent asks "write a new gate spec for routes/foo.js", Claude triggers `writing-api-gate-spec` and reads its `SKILL.md` from disk via bash. The bundled `TEMPLATE.md` + scripts only load if explicitly referenced. Net effect on agent prompts: drop the 150-line standing-rule preamble; just say "Use the `writing-api-gate-spec` skill. Target: routes/foo.js. Pattern: clone notifications-api.spec.js. Acceptance: standard set. Wire-in via wiring-spec-into-gate skill afterward."

**Tier 2 skills now shipped** (alongside the Tier 1 trio above):

| Skill | Use when | What it captures |
|---|---|---|
| [`adding-admin-trigger-endpoint`](.claude/skills/adding-admin-trigger-endpoint/SKILL.md) | Cron-engine spec needs a manual trigger surface (G-9/G-10/G-11/G-12/G-14/G-15 pattern) | Mirror `/api/forecasting/snapshot/run` shape with `verifyToken + verifyRole(['ADMIN'])` and per-tenant scope; optional `confirmDestructive` guard for destructive ops; AuditLog row writes for GDPR; the wellness-vertical `verifyWellnessRole` carve-out. Bundled `TEMPLATE.js` with all 3 variants. |
| [`bumping-version-docs`](.claude/skills/bumping-version-docs/SKILL.md) | A wave shipped enough commits to warrant a vX.Y.Z bump (4+ closer agents, or a focused multi-day pickup) | The 5-file dance: CHANGELOG (with test-surface delta table + Carry-over section), README (version + What's-new max-6-bullets), CLAUDE.md (version + count refresh), TODOS (handoff block rewrite), E2E_GAPS (✅ markers). Bundled `CHANGELOG_ENTRY_TEMPLATE.md` + `TODO_HANDOFF_TEMPLATE.md` + `README_WHATSNEW_TEMPLATE.md`. |
| [`dispatching-parallel-agent-wave`](.claude/skills/dispatching-parallel-agent-wave/SKILL.md) | User asks to "fire up parallel agents" or there's a batch of 3+ unblocked items | Disjoint-files invariant; 4-agent default cap (5 worked, 8 bundles); discovery-first vs jump-to-closers patterns; the standing-rule preamble that points agents at the existing skills (saves ~150 prompt-lines per agent); rebase-on-collision recovery; consolidation steps after the wave returns. Bundled `AGENT_PROMPT_TEMPLATE.md` with role-specific adaptations (closer / discovery / engine-fix / heal-loop). |

**Tier 3+ skills still planned** (build inline-with-first-use when those tasks come up):
- `closing-contract-drift-bug` — engine-side fix + unit test with anti-regression assertion against the old broken form (the #410/#411 pattern)
- `local-heal-loop` — boot stack → run gate → diagnose → fix → retry → cap at 5 iterations
- `scrubbing-demo` — the SSH operator pattern via `.scripts/ssh-run.py`
- `filing-contract-drift-issue` — the 5-section issue-body format used for #408–#411
- `tagging-release` — pre-tag verification + `git tag -a` + e2e-full release-validation watch
- `writing-tenant-isolation-resource` — the G-20 per-resource-config snippet pattern (build inline with G-20 wave 3+)
- `splitting-large-route-file` — the G-17/G-18/G-19 wellness.js split pattern (build inline)
- `adding-frontend-page-spec` — patient-portal-style E2E pattern (build inline with G-21 prep)
- `writing-claude-skill` — the meta-recipe (build LAST so it captures lessons from authoring the others)

**Local stack state when this handoff was written:** Docker MySQL on `:3307` is running, backend may or may not be up depending on whether anyone hits `local-stack-down.ps1`. If you boot fresh: `.\scripts\local-stack-up.ps1` then `.\scripts\test-local.ps1 -Local` to verify all 4 gates green.

---

Last updated: 2026-05-03 (**v3.4.3 shipped — eight-agent parallel wave continuing v3.4.2 same day.** HEAD: post-014ac6a. **Per-push gate is now 50 specs / ~1,665 API tests + 30 vitest files / 803 unit tests = ~2,468 passing on every push.** Major movements since v3.4.2:

- **Six new gate specs** (G-12 campaign + G-13 deal-insights + G-15 backup + R-1 trio: ab-tests/accounting/canned-responses) totalling +140 API tests
- **Six new vitest unit-test files** (lib/prisma + lib/sentry + cron/recurringInvoice + cron/retention + cron/wellnessOps + cron/appointmentReminders, plus schema/schema-invariants for G-24) = +103 unit tests
- **Both v3.4.2 contract-drift bugs closed**: #410 recurring-invoice VOID/VOIDED + #411 retention no-op AuditLog. Plus bonus vitest.config.js cron/ deps.inline unblock that the engine-fixes agent shipped en route — was silently blocking ALL cron-engine unit tests.
- **2 spec-discipline cleanups**: B3 wellness-real-user-journeys (sessionStorage admin token shadowing — NOT tab-locator drift); wellness-clinical-api Location rename (`_teardown_wc_loc_*` mirrors G-6 pattern; demo-hygiene's residue regex misses).
- **G-24 schema invariants** with revert-and-prove verification; surfaced 49 models with `tenantId` but no formal `tenant Tenant @relation` + 21 `@@unique` constraints without docs + `MarketplaceLead.@@unique([provider, externalLeadId])` may prevent cross-tenant lead import.
- **Outstanding contract-drift findings worth filing**: Campaign in-memory `global._campaignSchedules` (silent data loss on restart); the 3 schema findings from G-24.

**Earlier same-day arc (v3.4.0 / v3.4.1 / v3.4.2):**

- **Six more gate specs landed** (G-7 + G-9 + G-10 + G-11 + G-14 + G-16) on top of the v3.4.0 batch. Gate growth: 31 → 37 specs, 1,435 → ~1,525 API tests; vitest 677 → 700.
- **Four new admin-gated cron-trigger endpoints** added so each engine becomes deterministically testable from the manual path: `POST /api/forecasting/snapshot/run` (G-14), `POST /api/billing/recurring/run` (G-9), `POST /api/email/scheduled/run` (G-10), `POST /api/gdpr/retention/run` (G-11 — additional `confirmDestructive: true` body guard + per-deletion AuditLog row for GDPR audit-trail completeness). All mirror the established pattern: per-tenant scoped, `verifyRole(['ADMIN'])`, return `{success, tenantId, ...counters, errors}`.
- **Two contract-drift bugs surfaced + filed** by the new specs (engine-side, NOT fixed in their PRs):
  - #410 — `recurringInvoiceEngine` excludes `'VOID'` but `/void` route writes `'VOIDED'`; voided recurring invoices may regenerate via cron path
  - #411 — `retentionEngine` skips AuditLog on no-op runs; GDPR Art. 30 / SOC-2 expects every sweep logged
- **Two cross-project pattern docs shipped** for hand-off to sister Globussoft products:
  - [docs/DEMO_MONITOR_PATTERN.md](docs/DEMO_MONITOR_PATTERN.md) — copy-paste guide for demo-monitor pattern (commit `c27d862`)
  - [docs/LIVE_MONITOR_PATTERN.md](docs/LIVE_MONITOR_PATTERN.md) — production-grade variant with severity tiers + PagerDuty + dry-run rollout (commit `331cdd6`)
- **Demo-monitor cadence relaxed** `*/30` → `0 */2` (12 runs/day instead of 48). Justified by today's automation: `e2e-full.yml`'s `scrub-demo` post-matrix job + ephemeral-CI architecture close the bulk of the residue class.
- **Audit-api spec header refresh** (`e834266`) — cleared stale comments claiming `routes/audit.js` had no role guard (#408 fixed in v3.4.0; comments hadn't caught up).

**Carried over from v3.4.0 / v3.4.1** (still relevant context for new picker-uppers):
- T1.2 SMS provider live end-to-end via Fast2SMS (admin banner + portal/health + PatientPortal degrade + real key on demo + local). Patient OTP + appointment reminders + telecaller SMS now actually deliver.
- e2e-full long-tail (L1/L2/L3) all closed as no-fix — they were test races and env mismatches, not product bugs.
- 8 earlier gate specs (G-1/G-2/G-3/G-4/G-5/G-6/G-8/G-25) from v3.4.0.
- 2 earlier compliance bugs closed (#408 audit role guard, #409 integrations toggle).
- `Activity.description` → `@db.Text` schema migration.

**Pickup from home:** `git pull origin main`. Full local gate green at HEAD. **Next gap-spec batch:** G-12 campaign-engine + G-13 deal-insights-engine + G-15 backup-engine in parallel (3 disjoint files; G-15 includes a PII-safety check on dump contents). **G-20 tenant-isolation-api spec** (2-3 days) is the highest-severity multi-day pickup — single highest-risk bug class for multi-tenant CRM; natural to tackle after the engine specs settle. **G-17/G-18/G-19 wellness.js route split** (1 day each) best after G-20 since the isolation contract should be locked down before structural changes.

Earlier session notes (2026-05-02 evening — context for prior commits): T1.1 e2e-full restoration shipped + bucket-4 partial + T1.2 partial. e2e-full failures **201 → 25 unique** via 4 test commits + `cbf9d27`. T1.2 partial (`e941d7b`): `/api/auth/me` now exposes `features.smsConfigured`; consumer side (admin banner + patient portal graceful degrade) is NOT yet shipped — see "🚧 T1.2 — remaining work" below.)

Earlier 2026-05-02: **closed-issue regression audit + architect-priority sequencing** added at top. See "🎯 Architect-priority sequencing (2026-05-02)" below. The detailed 24-item regression-coverage backlog mapping every closed issue → which spec would prevent it from regressing is in [docs/regression-coverage-backlog.md](docs/regression-coverage-backlog.md). Pick from the architect sequencing first.

Previous update: 2026-05-01 (afternoon — repo hygiene pass + e2e-full debrief; 3 commits `b281dd6` / `84129a9` / `5e364d6`. ESLint warnings 180 → 1, secret-scan back to functional, GitHub Actions checkout/setup-node v4→v5).

---


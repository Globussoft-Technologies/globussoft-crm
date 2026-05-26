> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-03 evening — second wave) — superseded above

**HEAD on origin/main:** `04e5b56`. Tag `v3.4.3` was pushed → e2e-full release-validation now firing against demo for the first time since v3.3.0 (~70 commits ago).

**What shipped this session (4 commits + 1 tag + 5 issues):**

| Commit | What |
|---|---|
| (tag) `v3.4.3` at `97a6428` | First release tag since v3.3.0; triggers e2e-full release-validation |
| (workflow_dispatch) `coverage.yml` run | Refreshes routes/helpers coverage % post-v3.4.x (was last measured at 40.52% / 79.01% on `868b227`, ~70 commits old) |
| (issues filed) #412 / #413 / #414 / #415 | Campaign in-memory schedule, 49 models without tenant relation, MarketplaceLead unique constraint, 21 @@unique without docs (the 4 contract-drift findings from CHANGELOG v3.4.3) |
| `a9154ac` | **G-20 first wave** — `tenant-isolation-api.spec.js` (404 lines, ~25 tests on first run, 8 resources covered: contacts, deals, tasks, billing, estimates + wellness/patients/services/locations). Wired into deploy.yml + coverage.yml gate lists |
| `04e5b56` | G-20 cleanup-fix — rename-on-cleanup pattern (`_teardown_iso_<id>`) for the 4 no-delete resources so they don't pollute demo on e2e-full runs |
| (issue filed) #416 | Pre-existing flake: `backup-engine-api.spec.js:632` MYSQLDUMP_FAILED test — has been blocking the deploy gate since `014ac6a` (canned-responses commit at 14:07Z). Pre-dates G-20 work but worth fixing first thing next session since it blocks per-push deploys |

**G-20 status:**
- ✅ Framework + 8 resources covered → ~25 tests, all passing in CI (verified on `a9154ac` deploy run)
- 🟡 Wellness clinical (visits, prescriptions, consents, treatment-plans) need FK-aware probes (next wave)
- 🟡 Generic CRM still needs: notifications (already isolated by notifications-api spec — skip), workflows, sequences, activities, audit log, scheduled emails, recurring invoices, webhooks, custom objects, custom fields
- 🟡 ~80 more tenant-scoped models in the long tail (per G-24's 109-model schema invariant catalogue)

**Three things to do first:**

1. **Fix #416 backup-engine flake (~30-60 min).** Per-push deploys are blocked. Either tighten MYSQLDUMP_BIN resolution in `backend/cron/backupEngine.js` so it doesn't fall back to PATH when an explicit path is set, OR update the test to use a strictly-missing scenario (e.g., point at a directory or non-executable file).

2. **Continue G-20 wave 2** (~half day). Add wellness/visits + wellness/prescriptions + wellness/consents + wellness/treatment-plans (need FK chain: Patient → Visit → Rx). Then add the remaining generic resources (workflows, sequences, audit, webhooks, custom-objects, scheduled-emails, recurring-invoices). Each is a one-line addition to RESOURCES; the framework already handles the probing.

3. **Decide on T2.1 mobile responsiveness vs G-21 frontend vitest+RTL** as the next multi-day flagship. T2.1 is the user-impacting one (clinics on phones); G-21 is the test-tier one (zero frontend isolation tests across 80+ pages). My architect-priority sequencing puts T2.1 first because adoption-blocker.

---


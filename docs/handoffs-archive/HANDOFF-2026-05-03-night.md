> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-03 night — 4-agent parallel wave + unblock) — superseded above

**HEAD on origin/main:** `561c8da`. Deploy gate ✅ GREEN (was red since `014ac6a` ~14:07Z; unblocked at 17:05Z by `51b299a`).

**Four parallel agents shipped in this wave + 2 fix-up commits:**

| Commit | What | Agent |
|---|---|---|
| `51b299a` | **fix(#416)**: backup engine respects MYSQLDUMP_BIN strictly — no PATH fallback. Real bug found: shell pipeline `mysqldump | gzip` was masking exit codes (no `set -o pipefail`); gzip always succeeded with 0-byte output. Pre-flight `fs.accessSync` + rename `CMD_BUILD_FAILED` → `MYSQLDUMP_FAILED` to match contract. **Per-push deploys unblocked.** | build-error-resolver |
| `5ca0849` | **fix(#412)**: persist Campaign schedules in DB — replaces in-memory `global._campaignSchedules`. Added `Campaign.scheduledAt`/`scheduleStatus`/`scheduleFilters` columns, rewrote `cron/campaignEngine.js` (70 → 148 lines) with exported `processDueCampaigns()`, routes/marketing.js writes DB instead of global, +6 vitest restart-survival tests, global map dropped. | Backend Architect |
| `8064fda` | **G-20 wave 2** test(api): tenant-isolation-api +9 resources (workflows, sequences, projects, tickets, developer-webhooks, scheduled-emails) + **wellness clinical FK chain** (Patient → Visit → Prescription, plus Patient → Consent). Tests ~25 → ~58. | general-purpose |
| `590011d` | **feat(T2.1)**: mobile sidebar collapse + drawer at <900px. CSS-class hamburger (the inline `display:none` from #228 was beating responsive.css), transform-based drawer, ARIA dialog/modal + focus trap, 44×44px touch target, vite build verified green. | Frontend Developer |
| `561c8da` | fix(test): tenant-isolation post-DELETE owner-read falls back to list lookup. Caught a false-positive: `routes/workflows.js` has POST + GET / + PUT/:id + DELETE/:id but **no GET /:id** — the post-DELETE silent-mutation check was reading the 404 as evidence of mutation. Now falls back to listing + checking for the id. | (orchestrator) |

**Issues closed:**
- ✅ #416 backup-engine MYSQLDUMP_FAILED (closed by `51b299a`)
- ✅ #412 Campaign in-memory schedule (closed by `5ca0849`)

**Per-push gate state:** ~52 specs / **~1,723 tests** + 31 vitest files / **~809 unit tests** = **~2,532 tests on every push, all green**. Live on demo.

**G-20 status:**
- ✅ Framework + 17 of ~109 resources covered (contacts, deals, tasks, billing, estimates, workflows, sequences, projects, tickets, developer-webhooks, scheduled-emails, wellness/{patients, services, locations, visits, prescriptions, consents})
- 🟡 Wellness clinical FK chain working end-to-end through Patient → Visit → Rx → Consent
- 🟡 Remaining ~92 multi-tenant models in long tail (per G-24 schema invariant catalogue)

**Three things to do first next session:**

1. **Verify v3.4.4 release tag.** The work shipped today is feature-complete enough for a tag. Recommend `git tag -a v3.4.4 -m "..." && git push origin v3.4.4` to fire the release-validation e2e-full and lock in the milestone.

2. **G-20 wave 3** (~half day). Add the next batch of resources to `tenant-isolation-api.spec.js`:
   - Activities (read patient/contact-scoped)
   - Recurring invoices via `POST /billing/recurring`
   - Audit log entries (admin-only, list-leak only)
   - Treatment plans (last wellness clinical resource — needs Patient + Service FK chain)
   - Custom records (under `/custom-objects/entities/:slug/records`)
   - Currencies, scim tokens, tenants (admin-only routes worth probing)

3. **Decide on T2.1's e2e validation.** The mobile sidebar shipped but `e2e/tests/responsive.spec.js` runs against demo only. After demo deploys, manually confirm the drawer works at 375×812 (iPhone 12 Pro) by hitting the demo URL or run responsive.spec.js against the deployed env. If the drawer doesn't actually slide-in, file a P1 against the T2.1 commit.

**Long tail still open:**
- #413 — 49 models without `tenant Tenant @relation` (cascade leak on `Tenant.delete()`)
- #414 — `MarketplaceLead.@@unique([provider, externalLeadId])` excludes tenantId
- #415 — 21 `@@unique` constraints lack documenting comments
- T2.2 — Audit-log middleware build-out (4-5 days; Patient/Visit/Rx/Consent mutations)
- T2.3 — Ship P1 of regression backlog
- G-21 — Frontend vitest+RTL setup (3-5 days; 80 pages + 11 components have zero isolated tests)
- G-22 — Integration test tier (msw/nock) — Stripe webhook signing
- G-23 — Migration safety check (prisma migrate dry-run in CI)

---


> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 SESSION HANDOFF (2026-05-14 home → office — v3.7.x stabilization arc → v3.7.16 fully-clean e2e-full + AI-era PRD + docs cleanup)

**HEAD on origin/main:** _will be the docs/handoff commit pushed at session-end_ (rebased onto `68af89d` docs cleanup sweep). Latest release tag: **v3.7.16** ([GH Release published](https://github.com/Globussoft-Technologies/globussoft-crm/releases/tag/v3.7.16) — **first fully-clean e2e-full validation in the entire v3.7.x arc**).

**Location handoff:** wrapping at home; **continuing from office** later today. Full state is checked into `origin/main`. Office session should pull, read this block, then read [docs/HANDOFF-2026-05-14.md](docs/HANDOFF-2026-05-14.md) for the deeper telemetry.

### What happened — the v3.7.x stabilization arc (16 → 0 hard failures across 9 spec-only releases)

Started the day with **60 open issues from a pen-test wave**. Wave A/B/C closed 9 product issues in v3.7.8. v3.7.8 e2e-full revealed 9 spec-rot failures from prior product changes (PR #710 / #713 / msg91 / cred mask). Each subsequent release fixed N specs but exposed M new specs hitting the same structural pattern. Two structural fixes ended the whack-a-mole:

- **v3.7.14** — global playwright `timeout: 60_000` + `retries: 3` (was 30s default + 2 retries)
- **v3.7.16** — wholesale `REQUEST_TIMEOUT 30000 → 60000` across all 110 spec files (per-request timeouts were silently overriding the v3.7.14 global ceiling)

**v3.7.16 e2e-full final tally**: 0 hard fails, ~50 flaky-passing-on-retry, ~4,400 tests passed across 4 shards. Run `25859013356`. Trajectory: v3.7.6 (16 hard fails) → v3.7.8 (9) → v3.7.9 (2) → v3.7.10 (1) → v3.7.11 (1) → v3.7.12 (1) → v3.7.13 (4) → v3.7.14 (1) → v3.7.15 (2) → **v3.7.16 (0)**.

### Plus

- **`docs/PRD_AI_ERA_CRM_REBUILD.md`** drafted (Draft v0.1) — 5-phase roadmap for evolving the CRM into an AI-era platform: semantic system of record / knowledge graph / multi-agent framework / conversational interface / digital teammates / real-time intelligence. ~590 lines. Triggered by a LinkedIn essay on next-gen enterprise software. Not implemented; planning artifact for stakeholder review.
- **Docs cleanup sweep** (`68af89d`) — 7 stale handoffs → `docs/handoffs-archive/`, 2 fully-closed gap docs → `docs/gaps/archive/`, README + CLAUDE.md de-rotted (stale counts replaced with auto-derived "At a glance" table), `docs/README.md` rewritten with cleaner sections + Archives index.
- **3 cron-learnings logged** to CLAUDE.md (`b18a6c9`): (a) spec-rot from intentional backend hardening is the dominant e2e-full failure mode; (b) `mode: 'serial' + 120s timeout` describe primitive for shared-resource tests; (c) demo-state convergence helpers must ACT every iteration, not just observe.

### Releases shipped today

10 tags pushed (v3.7.7 → v3.7.16). **v3.7.16 GH Release published** with full release notes covering the stabilization arc + pattern catalog. v3.7.7 → v3.7.15 are tag-only; no GH Releases for those (they're intermediate stabilization points, not product changes — v3.7.8 → v3.7.16 all ship identical demo binary).

### Two open issues remaining

- **#728 item 3** (free-trial vs role-gate copy conflation) — reopened by Wave C; needs product-side input from Rishu
- **#457** — manual-QA umbrella, intentionally open

Neither is a code defect. Everything autonomously-fixable is closed.

### Three things to do first next session

1. **Decide on v3.7.x intermediate tag publishing.** v3.7.7 → v3.7.15 are tags without GH Releases. The cleanest move: don't publish them individually (they're stabilization steps), reference them from v3.7.16's release notes (already done). If a stakeholder asks for v3.7.10 specifically (e.g. the last fully-product release before stabilization), can backfill its release notes.
2. **Stakeholder review of `docs/PRD_AI_ERA_CRM_REBUILD.md`.** Decisions to surface: Phase 1 launch tenant (wellness vs generic); embedding cost cap policy; Slack-first vs in-app-first for teammates; External Agent SDK publication; pricing model shift; sub-brand naming. Doc has them listed at section 9. **Phase 1 dev scoping is a separate cycle** — do not start implementation without alignment.
3. **Audit `docs/test-coverage-gaps.md` against current code.** Snapshot was 2026-05-06; 8+ days of active work since. Has a stale-warning banner now. Run `verifying-issue-before-pickup` SKILL.md on each card before dispatch — many likely already shipped (phantom-carry-over standing rule has 7 confirmed instances).

### Long tail still open

- **#431** Privacy retention silent-revert — ⬜ awaiting fresh repro
- **#457** manual-only QA umbrella — intentionally open (hardware/device surfaces)
- **Booking widget pincode-distance** — needs Google Distance Matrix API key (operator-blocked)
- **Lead_source naming drift** (cosmetic, ~30 min)
- **Mini-website at-store Resource reservation** — Booking widget UI surface (~2h)
- **CAL-1..CAL-7** — 7-item calendar integration backlog in [docs/CALENDAR_INTEGRATION_GAPS.md](docs/CALENDAR_INTEGRATION_GAPS.md)

### Per-push gate state

~4,400+ tests per push. e2e-full release-validation adds ~120 more specs not in the per-push subset (cross-machine guards in some specs limit them to local-stack runs).

---


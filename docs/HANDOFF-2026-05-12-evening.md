# Session handoff — 2026-05-12 evening (home → office)

## Quick state

| Field | Value |
|---|---|
| **HEAD on origin/main** | `4a3ef9c` (PR #710 fallout Round 4) |
| **Last release tag** | v3.7.5 (2026-05-11; multiple post-v3.7.5 commits not yet tagged) |
| **Last deploy gate** | GREEN — all 7 jobs success on `4a3ef9c` |
| **Demo state** | crm.globusdemos.com synced; deploy succeeded |
| **Open PRs** | 0 |
| **Open GitHub issues** | 11 (10 new pen-test items #711-720 + #457 manual-QA umbrella) |
| **In-flight engineering work** | None autonomously — all queued items closed or deferred |

## What shipped today (2026-05-12)

### Morning: all-issues sweep — 56 closures across 4 waves

A 60-issue pen-test backlog (30 CRITICAL + 24 MEDIUM + 6 LOW) had accumulated.
After phantom-carry-over audit (~18 turned out already-shipped), 4 parallel
agent waves landed real fixes:

- **Wave A** — quick wins + close 15 phantoms + demo data cleanup (`6cc8887` / `e4980d3` / `8bcd96f` / `822ab9c`). Removed 2,632 polluted Estimate rows + 152 Patient rows + 11 MembershipPlan rows + 4 stale VOIDED Invoices from demo.
- **Wave B** — 4 SECURITY/CRITICAL items (`f85dc45` #665 date validation, `a30a40d` #657 CSRF/origin, `ab046d4` #653 GiftCard bcrypt, `885645a` #651 Channels encryption).
- **Wave C** — `b4ea83b` #654 CSP + step-up auth.
- **Wave D** — `1364fea` (8 forms/UI consistency primitives), `2a4e21e` (4 PII masking items), `feb0fcc` (6 a11y/theme items).

Followed by `0a242b6` (cross-cutting shape-change fallout fix).

### Afternoon: 4 new skills shipped

`dbd8f9d` (554 lines) — 2 new skills + 2 extensions distilled from today's cron-learnings:

- NEW `.claude/skills/cleaning-demo-data-via-ssh/` — paramiko DB cleanup pattern (used by 3 successful scripts)
- NEW `.claude/skills/batch-closing-issues-after-multi-fix-commit/` — post-push verify + manual-close loop for the GitHub auto-close-trailer cap
- EXTEND `dispatching-parallel-agent-wave` — "When `--only` is NOT sufficient" section (6 working-tree-sweep instances today)
- EXTEND `auditing-cross-cutting-spec-impact` — response-shape grep checklist (w-B4 + w-C both missed sibling specs)

### Evening: PR #710 + 4-round fallout integration

`dc02453` — PR #710 by @mohitkumardas-cloud (#702 notification preferences + consent PDF fix). **Selectively merged** to preserve the 4 skill files that would have been silently reverted by the PR's stale base — `b72e6f8` fixup committed to the PR branch with `git checkout main -- .claude/skills/...`.

4 rounds of fallout fixes:
- Round 1 `6301249` — `arrayBuffer()` → `body()` for Playwright APIResponse + notif test `prisma.notificationPreference` mock stub + Layout.jsx TenantChip testid
- Round 2 `62fb8d8` — notif test mock returns "user opted in to everything" prefs row + Settings/UserSettings defensive `if (!prefs || !prefs.categoryToggles || !prefs.channels)` guards
- Round 3 `1940f28` — TenantChip `if (!tenant) return null;` guard
- Round 4 `4a3ef9c` — `Layout.test.jsx` `renderLayout` helper uses `'tenant' in args` check so explicit `tenant: null` reaches AuthContext (previously fell through to default)

### Evening cleanup: 9 phantom-reopened issues re-closed

A pen-test verification pass this morning re-opened 9 of the issues I closed yesterday evening (before the demo had today's fixes deployed). Re-closed with fresh citation comments pointing to today's commits. The fixes ARE shipped + verified green on deploy gate.

## Standing rules confirmed today

1. **PR pre-merge gate is a strict subset of per-push** — 4 more datapoints today across PR #710's fallout rounds (now ~10 confirmed instances). Every PR from an external author needs post-merge gate fallout planning.
2. **PR branched from stale base silently reverts work** — PR #710 would have reverted today's 4 skill files. Selective-merge with `git checkout main -- <reverted-file>` is the canonical recovery (referenced PR #566 `b78e484`).
3. **`git commit --only` working-tree-sweep** — 6 instances today on shared files (schema.prisma / deploy.yml / coverage.yml / index.css / security.js / Layout.jsx). Mitigation patterns now in `dispatching-parallel-agent-wave/SKILL.md`.
4. **GitHub auto-close trailer cap** — `Closes #A #B #C` only fires for first. New `batch-closing-issues-after-multi-fix-commit` skill encodes the verify-and-batch-close-manually loop.
5. **Cross-cutting response-shape change** — every test pinning the old shape must flip in the SAME commit. New grep checklist in `auditing-cross-cutting-spec-impact/SKILL.md`.

## Open work for the office session

See [docs/TODO-2026-05-13.md](TODO-2026-05-13.md) for the full ordered list. Headline items:

1. **NEW pen-test wave** filed during the session — issues #711-720 (10 items, 4 HIGH + 6 MEDIUM/LOW). Triage + fix.
2. **PR #710 carry-over verification** — pen-test team likely will re-test the notification preferences page on demo tomorrow. Address whatever re-opens (same pattern as today's 9 re-closures).
3. **Optional: tag v3.7.6** — today's post-v3.7.5 commits total ~12. Worth a tag + release-validation run if you want a clean release marker before the next pen-test cycle hits.

## What's NOT open / explicitly stays open

- **#457** Manual-only QA umbrella — intentional, stays open
- **#647** Tracking issue for user/operator/external blockers — refreshed at `ceaa429`; mostly closed-out
- **#699** Routing convention — deferred-for-product-input per #647 §9 (recommendation: option C hybrid)

## Where everything lives

- **CHANGELOG.md** — release-by-release record of what shipped
- **CLAUDE.md** — standing rules + cron-learnings + project context
- **TODOS.md** — engineering backlog (multi-day items)
- **docs/PENDING_USER_AND_OPERATOR.md** — user/operator/external blockers (was #647 source)
- **docs/HANDOFF-2026-05-11.md** — yesterday's home→office handoff
- **docs/HANDOFF-2026-05-12-evening.md** — this doc
- **docs/TODO-2026-05-13.md** — tomorrow's office to-do
- **docs/ZYLU_PRD_ACCOMPLISHED.md** — Zylu PRD audit summary (mostly-shipped)
- **.claude/skills/** — 18 skills total (16 from earlier + 2 added today)

## Last commit at session close

`4a3ef9c` — `fix(deploy-gate): PR #710 post-merge fallout — Round 4 (Layout.test.jsx tenant: null fall-through)`

Working tree clean. All deploy gates green. Demo synced.

---

**Session start:** 2026-05-12 morning (post-v3.7.5 release)
**Session end (home):** 2026-05-12 evening
**Pick up in office:** triage #711-720 + handle any PR #710 follow-up re-opens.

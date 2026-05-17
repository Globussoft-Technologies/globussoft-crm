> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 PREVIOUS-SESSION HANDOFF (2026-05-06 evening — long autonomous session: 9 issues + 4 PR carry-overs + B-01 + 5 standing rules + new endpoint) — superseded by v3.4.13 release above

**HEAD on origin/main:** `aafa1e2` (#515 push send-test endpoint). Working tree clean. All 16 commits this session pushed; CI gate green on the latest. Operator-blocker count: **0** (B-01 shipped, B-02 dropped per user direction).

### Why this session was long

User started with "let's keep the blockers one by one and finish [the list]," then `do these` / `go ahead` / `sure` through every recommended pick. ~16 distinct deliverables across the operator-blocker, autonomous-cleanup, test-coverage, and small-feature lanes.

### What shipped (16 commits since `1723ec9`)

| # | Commit | What | Closes |
|---|---|---|---|
| 1 | `d884924` | Filed 8 v3.4.12-wave follow-ups as tracked issues | #513 #514 #515 #516 #518 #519 #520 #521 (filed) |
| 2 | `539e6ba` | 4 v3.4.12-wave learnings → CLAUDE.md "Standing rules" (--accent-color rule, min-width:0 chain, single-source responsive grid, lint-rule defensive policy) | (skill ↔ CLAUDE) |
| 3 | `5960864` | **B-01 SHIPPED** — Cloudflare Turnstile keys deployed to demo via new reusable [scripts/apply-turnstile-env.py](scripts/apply-turnstile-env.py) (paramiko + SFTP + backup-rollback) | B-01 |
| 4 | `df91ee3` | 5th v3.4.12 learning → AGENT_PROMPT_TEMPLATE.md "Commit hygiene" (`git commit -o`) + skill update | (skill) |
| 5 | `dd02712` | Dropped B-02 from operator-blocker section per user direction | B-02 |
| 6 | `b9a8ab8` | **PR #511 blocker #2** — `notificationService.test.js` updated: env var swapped MAILGUN→SENDGRID, un-skipped previously-broken positive-path test, **5 new SendGrid contract tests** | PR #511 #2 |
| 7 | `32ce3c8` | Mailgun→SendGrid sweep on 4 e2e spec headers (cosmetic narration, no assertion changes) | (cleanup) |
| 8 | `0b3b2b2` | **#513 closed** — 1fr 2fr mobile-collapse on Contracts/Estimates/Expenses/Projects (4 files, 12 edits, identical recipe) | #513 |
| 9 | `1ea592d` | **#520 closed** — 5 wellness off-brand color stragglers in Playbooks + Reports | #520 |
| 10 | `66b7526` | **Trivial sweep** — #519 deep-link consumption + PR #511 #6 CORS comment + #511 #10 SMS placeholder cosmetic in one commit | #519, #511 #6, #511 #10 |
| 11 | `f68501e` | **PR #511 #13** — regression guard pinning `/api/sms/send` `{to, body}` minimal-shape contract | #511 #13 |
| 12 | `768607c` | **PR #511 #9** — CallMonitor brand-color fixes (9 edits, primary CTAs → primary-color, Material palette → semantic theme vars) | #511 #9 |
| 13 | `aafa1e2` | **#515 closed** — `POST /api/push/send-test` endpoint (recipient inferred from req.user.userId), Channels.jsx workaround removed, 4 new gate tests | #515 |

### Issues closed this session (9 GitHub-tracked + 4 PR carry-overs + B-01)

GitHub: ✅ #513 #515 #519 #520 (4 fixed) + #195 #213 (drift-already-shipped during this session by other means — closed via verify-only) + carry-overs #2 #6 #9 #10 #13 from PR #511 review.

Plus the verify done on **#518** (filed as a comment, not closed — see below).

### #518 verify finding — REAL bug, fix is contained (~30m)

Read `backend/services/whatsappProvider.js` end-to-end. **Backend Meta-Cloud-spec shape is correct in BOTH branches** — `sendTemplate` and `sendText` post valid Meta v18 payloads. The bug is at the frontend↔route boundary:

- [Channels.jsx:698](frontend/src/pages/Channels.jsx#L698) posts `{to, body, templateId}` (templateId is an INT — the schema id)
- [whatsapp.js:10](backend/routes/whatsapp.js#L10) destructures `{to, body, templateName, parameters}` (templateName is a STRING — the Meta template name)

`templateId` is silently dropped. Route falls into the session-text branch via `body` set / `templateName` undefined. **Outside Meta's 24h re-engagement window this returns a Meta error** ("more than 24 hours have passed since the customer last replied"). Customer-outreach to anyone who hasn't messaged in 24h fails silently with a non-obvious Meta error. Re-classify Medium-High in practice.

**Recommended fix:** swap Channels.jsx to `templateName: template.name` + extract template variables to `parameters: [{type:'text', text}, ...]`. Backend already handles correctly. **No backend changes needed.** Plus add the regression-guard spec at `e2e/tests/whatsapp-api.spec.js` (doesn't exist yet — wire into deploy.yml + coverage.yml). Diagnosis posted as a comment on the issue: https://github.com/Globussoft-Technologies/globussoft-crm/issues/518

### Open backlog at handoff (autonomous-fixable, none operator-blocked)

| Item | Effort | Type |
|---|---|---|
| **#518** /api/whatsapp/send shape mismatch — frontend swap + new spec | ~30m + spec | Verified-real-bug, ready-to-fix |
| **#514** responsive.css:151 broken Calendar selector + sweep for similar attribute-selector brittleness | ~1h | Small refactor |
| **PR #511 #7** Inbox modal patterns refactor (two competing modals — `detail` for sms/wa/call + `selectedEmail` for emails) | ~1-2h | Mid-size cleanup |
| **PR #511 #4** CallMonitor backend WS or remove dead code | ~½d | Bigger investigation |
| **#516** /api/sms/send-bulk multi-recipient envelope (mirror #435) | ~3-4h | Bigger feature |

**Estimate to reach 0 open autonomous issues**: ~4-6 hours of focused work. The #518 fix is the highest-value next pickup (real bug, contained fix, diagnosis already complete).

### Per-push gate state at handoff

- Test surface: **+5 SendGrid contract tests** (notificationService.test.js) **+4 push send-test tests** (push-api.spec.js) **+1 SMS shape regression** (sms-api.spec.js) = **+10 new contract tests** in this session
- 4 e2e specs got cosmetic Mailgun→SendGrid header sweeps (no assertion changes)
- All 16 commits' deploy.yml runs went green (per `gh run list` checks during the session)
- Demo on HEAD; B-01 keys live; everything that can be tested by smoke-clicking the demo works

### Process learnings promoted this session (5 of 5)

1. `--accent-color` vs `--primary-color` rule (CLAUDE.md "Standing rules") — round-tripped 6 issues this session (#520 + PR #511 #9 alone hit 14 instances)
2. `min-width: 0` chain pattern (CLAUDE.md)
3. Single-source responsive grid pattern (CLAUDE.md)
4. Lint-rule defensive policy (CLAUDE.md)
5. `git commit -o` parallel-wave hygiene (`dispatching-parallel-agent-wave` skill + AGENT_PROMPT_TEMPLATE.md)

### Three things to do first next session (from home)

1. **Close #518** — the verify finding posted to the issue gives you the exact 30-min fix. Channels.jsx:698 swap (`templateId` → `templateName: template.name`) + new `e2e/tests/whatsapp-api.spec.js` regression-guard spec wired into deploy.yml + coverage.yml. No backend changes.
2. **Pick from backlog** — recommend #514 (1h, small) or PR #511 #7 (1-2h, modal refactor) as the next medium pickup. PR #511 #4 is the only "bigger" item that's still ready-to-investigate.
3. **Demo smoke** — open `https://crm.globusdemos.com` and walk through: (a) the 4 fixed pages on a 375px viewport — Contracts/Estimates/Expenses/Projects should now stack cleanly; (b) any landing page with `enableCaptcha: true` → Turnstile widget should render; (c) Channels Push tab "Test" button → click and verify it lands a notification (or a clear "no subscription" toast).

### Skills inventory (10, unchanged in count)

`adding-admin-trigger-endpoint`, `applying-demo-ssh-config`, `bumping-version-docs`, `capturing-wave-findings`, `dispatching-parallel-agent-wave` (extended this session with `git commit -o`), `reporting-agent-progress`, `triaging-stuck-deploy-gate`, `verifying-issue-before-pickup` (Pattern E from earlier session), `wiring-spec-into-gate`, `writing-api-gate-spec`, `writing-vitest-unit-test`.

Earlier session arc (2026-05-05 evening): see superseded handoff below — 2 PRs merged + SendGrid live + 6-issue cluster triaged.

---


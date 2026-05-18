> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 PICKUP-AT-HOME HANDOFF (2026-05-05 evening — 2 PRs merged + SendGrid live on demo + 6-issue cluster triaged) — superseded above

**HEAD on origin/main:** `ca4b734` (skill update — Pattern E added). Demo at `8b747db` (#509 silent-toast fix; 6/6 deploy gates green). Per-push gate ✅ GREEN. Working tree clean.

### Why this session

User picked up from office to: review/merge open PRs, triage open GitHub issues, fix anything actionable. Two PRs were open (#511, #512), 6 fresh QA-cluster issues filed for /invoices (#505-#510) plus the carry-over 3 from the morning.

### What shipped this session (5 commits since v3.4.12 carry-over `548da0f`)

| Commit | What | Closes |
|---|---|---|
| `8b59fcb` | **PR #512 squash-merged** — UI responsiveness + call-dialer modal + .btn-secondary styling + Sidebar Channels nav. Same author (`shiksharoy-ai`) as PR #453. **Side-effect regression**: dropped the `{detail && ...}` row-detail modal block in Inbox.jsx while keeping `setDetail()` callsites — sms/wa/call rows clicked → modal didn't render. Restored by PR #511's rebase below. | (PR) |
| `f489df1` | **PR #511 squash-merged** — Mailgun → SendGrid swap + SMS compose modal + Live Call Monitor (frontend only) + email-detail modal + ALLOWED_ORIGINS env-drive + Vite `@` alias. Required local rebase (2 file conflicts) + inline fix for blocker #1 (`recipient` → `to` regression in /send-email loop, would have undone v3.4.12 #435). PR #512's dropped detail modal restored. | (PR — see carry-over below for blockers #2-#13) |
| `8b747db` | **fix(#509)** — sidebar count fetches now pass `{silent:true}` per fetchApi's documented background-poll contract. 4-line change; `.catch(()=>null)` on safeLen already kept previous count, the toast was redundant noise. | #509 |
| `ca4b734` | **skill update** — Pattern E (cluster-of-attributed-causes) added to `verifying-issue-before-pickup`. v3.4.12+ drift-rate now 5/6 = 83% (vs 50% baseline at v3.4.8/9). | (skill) |

### SendGrid plumbing (live on demo, no commit)

The Mailgun→SendGrid swap in PR #511 made `process.env.SENDGRID_API_KEY` the new email-provider gate. **Discovery during operator setup**: demo's `backend/.env` had **no MAILGUN_API_KEY** (`grep -c "^MAILGUN_API_KEY=" → 0`). Demo email has been silently broken the entire time. Three setup steps this session:

1. `backend/.env` (local, gitignored) — written via Write tool to avoid terminal echo
2. GitHub Actions repo secret `SENDGRID_API_KEY` — set via `gh secret set --env-file backend/.env` (no key in command line)
3. Demo `backend/.env` via SSH — `applying-demo-ssh-config` skill pattern: backup → idempotency check → SFTP-write tmp → append → `pm2 restart --update-env` → curl /api/health verify (post-fix /api/health was healthy at v3.4.12)

**Once the deploy with PR #511's SendGrid code lands, demo will deliver email for the first time.** Worth a smoke test (send a real email through /api/communications/send-email or the Inbox compose) — same shape as the `36e554d` Contact-upsert latent bug post-#445 Nginx unblock. **Test as a real user before demo-day.**

### Issues closed this session (6, via the verifying-issue-before-pickup skill)

QA filed a 6-issue cluster (#505-#510) on /invoices today. Verification at HEAD `f489df1`:

- ✅ **#509** widget→global toast (REAL fix, `8b747db`) — sidebar polls now silent-mode
- ❌ **#505** 4 endpoints return 503 — not reproducible (curl all 4 + filter combos + burst tests + edge cases → 200; suspected transient at filing time)
- ❌ **#506** filtered query param 503 — same as #505, A/B comparison shows healthy
- ❌ **#507** infinite retry loop — doesn't match code (Sidebar polls every 60s; no retry in `safeLen` or `fetchApi`)
- ❌ **#508** misleading "check your connection" toast — doesn't match code (`api.js:154` returns "Server error" on 5xx; "check your connection" only fires on no-response)
- ❌ **#510** wallet extension exceptions — third-party browser extension noise, not actionable on our side

5 of 6 = 83% drift rate. Exact pattern Pattern E in the skill describes.

### Open backlog

**Blocked on user input** (state unchanged from morning):
- **B-01** TURNSTILE_SECRET_KEY env-var on demo (operator-blocker)
- **#431** [P2][privacy] retention form silent-revert — awaiting fresh repro
- **#437** [P3][marketplace] /marketplace-leads visibility indicator — awaiting product-design call
- **#457** Manual-only QA umbrella — intentionally stays open

**No autonomous-fixable items remain in the GitHub backlog.**

### Carry-over from PR #511 (NOT addressed in the merge — needs follow-up)

The merge resolved conflicts + fixed blocker #1 (regression) inline. The other blockers from my PR #511 review are still in the merged code:

| # | Issue | Severity | Action |
|---|---|---|---|
| 2 | No SendGrid test coverage in any spec/vitest (no extensions to email-api / communications-api / email-scheduling-api specs or cron/lib vitests) | High | Add a dedicated SendGrid mock pattern + extend the 4 specs + 3 vitests. ~2-3h. |
| 4 | CallMonitor frontend has no backend WS route — dead code on landing | Medium | Either remove the CallMonitor files in a follow-up commit OR ship the backend `/ws/monitor/:streamSid` handler + spec. ~half-day if backend is wired up. |
| 5 | ~~Mailgun fallback restoration~~ | | **User said skip for now**, may revisit later. NO action. |
| 6 | Hardcoded `globuscrm.globussoft.com` CORS origin (one of 3 ALLOWED_ORIGINS additions). Other 2 (FRONTEND_URL + CORS_ALLOWED_ORIGINS) are env-driven and fine. | Medium-low | Move to env-var or add a code comment justifying the literal. ~5 min. |
| 7 | Two competing modal patterns in Inbox.jsx (`detail` for sms/wa/call + new `selectedEmail` for emails). Code resolution kept both with a comment flagging blocker #7. | Low | Pick one pattern and migrate the other. ~1-2h cleanup. |
| 9 | CallMonitor brand-color violations (`var(--accent-color)` for primary CTA + hardcoded Material colors). | Low | Use `var(--primary-color, var(--accent-color))` for primary CTAs; replace hardcoded with theme-aware. ~30 min. |
| 10 | SMS placeholder uses real-looking `+919830087848` | Trivial | Replace with `+91 XXXXXXXXXX`. ~1 min. |
| 11 | server.js cosmetic re-indentation churn from PR #511 (~63 lines of whitespace shift) | Trivial | Optional clean-up commit; not blocking. |
| 12 | Vite `@` alias mixed with relative imports across the codebase | Low | Either commit to migrating all imports OR keep relative for consistency. Not in this PR's scope; longer-term style decision. |
| 13 | Verify `/api/sms/send` accepts `{to, body}` shape | Low | Quick spec check + extension if needed. ~30 min. |

Plus the v3.4.7 carry-over still applies: the 1-line fix at line 190 of `routes/communications.js` was applied during merge — preserves v3.4.12 #435 multi-recipient behavior.

### Follow-ups filed as GitHub issues 2026-05-06

All 8 v3.4.12-wave follow-ups now have tracking issues. Each carries the diagnosis, fix recipe, file:line refs, and effort estimate from the source agent's finding:

| # | Issue | Severity | Effort |
|---|---|---|---|
| 1 | [#513](https://github.com/Globussoft-Technologies/globussoft-crm/issues/513) `1fr 2fr` widespread on Contracts/Estimates/Expenses/Projects | Medium | 30m, 4-agent disjoint batch |
| 2 | [#514](https://github.com/Globussoft-Technologies/globussoft-crm/issues/514) `responsive.css:151` broken attribute selector + sweep | Low | ~1h |
| 3 | [#515](https://github.com/Globussoft-Technologies/globussoft-crm/issues/515) `POST /api/push/send-test` first-class endpoint | Low | ~1h |
| 4 | [#516](https://github.com/Globussoft-Technologies/globussoft-crm/issues/516) `POST /api/sms/send-bulk` multi-recipient envelope (#435 mirror) | Medium | 3-4h |
| 5 | [#518](https://github.com/Globussoft-Technologies/globussoft-crm/issues/518) `POST /api/whatsapp/send` Meta Cloud spec verify | Medium | 30m + 1-2h fix |
| 6 | [#519](https://github.com/Globussoft-Technologies/globussoft-crm/issues/519) `Channels.jsx` `useSearchParams()` deep-link | Low | ~5m |
| 7 | [#520](https://github.com/Globussoft-Technologies/globussoft-crm/issues/520) 5 wellness off-brand color stragglers | Low | ~30m |
| 8 | [#521](https://github.com/Globussoft-Technologies/globussoft-crm/issues/521) PR-level CI extension (vite build + ESLint on PRs) | Medium | ~10m |

**Filing notes:** GitHub returned 504 twice during the run; #517 was a duplicate of #516 created by a transport-level retry (closed as not-planned, body consolidated on #516). Total backlog inflation: 8 fresh tracked items, ~7-8h of work spread across the surface, several are perfect parallel-agent disjoint-files batches.

### Process learnings still un-promoted (5 from v3.4.12 wave)

These were noted in the previous handoff and remain candidates for promotion to CLAUDE.md standing rules / skills:

1. `--accent-color` vs `--primary-color` (wellness `--accent-color` is salmon secondary; CTAs should use `--primary-color`)
2. `min-width: 0` chain for ellipsis on flex/grid children
3. Single-source responsive grid pattern: `repeat(auto-fit, minmax(min(100%, 240px), 1fr))`
4. **`git commit -o <file>`** for parallel-agent waves (commits ONLY named files even if siblings staged things)
5. Lint-rule defensive policy: verify `eslint-disable-next-line <rule>` is configured before adding

(Pattern E from this session is already promoted in the verifying-issue-before-pickup skill.)

### Three things to do first at home

1. **Smoke-test demo email** — log in as admin@globussoft.com on `https://crm.globusdemos.com`, compose an email via `/inbox` to a real address you control, and confirm it lands. This validates that the SendGrid swap + the operator setup actually works end-to-end. If it doesn't deliver, check `pm2 logs globussoft-crm-backend` on demo for SendGrid 4xx/5xx errors. Same shape as the `36e554d` post-Nginx-unblock latent bug class.

3. **PR #511 carry-over (test coverage)** — blocker #2 is the highest-value remaining item. Adding SendGrid mock-and-test coverage to email-api / communications-api / email-scheduling-api specs + cron/lib vitests would catch regressions in the new code path. The existing tests use Mailgun's `URLSearchParams` + Basic auth shape; the new SendGrid path uses JSON + Bearer. Without test extensions, the auto-mocked tests pass blindly. ~2-3h focused work.

### CI / deploy state at handoff

- **HEAD `ca4b734`** — local matches origin/main. Working tree clean.
- **Demo on `8b747db`** — last successful deploy; #509 silent-toast fix live.
- **`ca4b734` deploy** — auto-fired on push of skill-update commit; will land in ~3 min (skill-only commit; should pass all gates trivially).
- **No outstanding red gates.** No outstanding rollbacks.

### Skills inventory (10)

`adding-admin-trigger-endpoint`, `applying-demo-ssh-config`, `bumping-version-docs`, `capturing-wave-findings`, `dispatching-parallel-agent-wave`, `reporting-agent-progress`, `triaging-stuck-deploy-gate`, **`verifying-issue-before-pickup` (Pattern E added)**, `wiring-spec-into-gate`, `writing-api-gate-spec`, `writing-vitest-unit-test`.

Earlier session arc (2026-05-05 morning): v3.4.12 RELEASED + 27-issue closure wave fully shipped — see superseded handoff below.

---


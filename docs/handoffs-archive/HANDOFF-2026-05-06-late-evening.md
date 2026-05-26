> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 PICKUP-AT-HOME HANDOFF (2026-05-06 late-evening — #524 SSH probe + #550 sweep + PR #549 closed + B-03 partial)

**HEAD on origin/main:** `faf4f6c` (sla-breach-api spec alignment to #550). Deploy ✅ GREEN, demo on HEAD. Working tree clean.

### Why this session

User picked up post-v3.4.14 to: review the open PR (#549), fix the version-pin doc drift, and SSH-probe #524 to find why /send-now was failing on demo. Each ask uncovered something:
- PR #549's claimed fixes were mostly duplicates of v3.4.14's pen-test sweep (closed, not merged)
- v3.4.14 didn't bump README/CLAUDE.md version pins (drift fix shipped)
- #524 SSH probe surfaced a SECOND latent bug (errorMessage column too narrow → P2000 → SEND_NOW_INTERNAL instead of intended SENDGRID_REJECTED). Fixed. Re-probe then surfaced the actual upstream blocker: SendGrid Sender Identity not verified — filed as B-03

Then user said "do 1, 2, 3" on the v3.4.14 handoff list:
1. **B-03 verify** → still pending (see below)
2. **#550 envelope sweep** → shipped (single coordinated PR, 32 files, +59/-64)
3. **PR #549 cleanup** → closed with pointer comment

### What shipped this session (5 commits, all CI-green at HEAD)

| Commit | What | Closes |
|---|---|---|
| `edf4b89` | docs: README + CLAUDE.md version pins v3.4.13 → v3.4.14 (post-v3.4.14 doc-drift fix; bumping-version-docs convention) | (drift) |
| `316d5a0` | fix(#524 follow-up): widen `ScheduledEmail.errorMessage` to `@db.Text` + bump slice cap to 4000. SSH probe found P2000 column-too-long was masking the real SENDGRID_REJECTED code path. Schema change auto-applied to demo via deploy.yml's prisma db push step (line 627). | (#524 follow-up) |
| `bcd2296` | docs(TODOS): file B-03 — SendGrid Sender Identity unverified. Real upstream blocker: every email-send attempt has been failing because `noreply@crm.globusdemos.com` was never verified in SendGrid since the v3.4.13 swap. Demo email has been silently dead. | (TODOS) |
| `8853546` | fix(#550): per-route response shape sweep — 34 sites across 22 route files. DELETE → 204 No Content (20 sites); state-change ack handlers → `{status, code, ...}` (14 sites). 11 spec files updated in lockstep. SPA frontend audit clean (zero `body.message` consumers). | #550 |
| `faf4f6c` | fix(#550): missed `sla-breach-api.spec.js` (named for engine not route) — DELETE-200 assertion → 204. Caught by api_tests gate on 8853546's first deploy attempt; deploy was correctly skipped, second push went green. | #550 follow-up |

### Issues closed / actioned this session

✅ **#524** verification fully closed — error path now surfaces the actual SendGrid response in the row's `errorMessage` (column widened to TEXT). Tested end-to-end on demo via /send-now id 210. The v3.4.14 handoff item #1 ("read #524's first failed-on-demo response body") is done.
✅ **#550** per-route envelope sweep shipped (commit `8853546` + `faf4f6c` follow-up). Auto-closed by the `Closes #550.` trailer on landing.
✅ **PR #549** closed — pointer comment recommends author open a fresh focused PR with ONLY the unique #523 + Marketplace work (the PR's other 6 claimed fixes were duplicates of v3.4.14's same-day pen-test sweep).

### B-03 — Sender Identity STILL PENDING ⚠️

User reported B-03 done; smoke test re-run found it still failing with the same error. Diagnosis via SSH:
- Demo's `backend/.env` does NOT set `SENDGRID_FROM_EMAIL` → code falls back to the hardcoded default `noreply@crm.globusdemos.com`
- SendGrid is still rejecting that specific FROM address
- Most likely root cause: user verified a DIFFERENT address (probably their own work email — that's where the SendGrid verification click-through email lands), but demo's hardcoded FROM doesn't match

**Two paths to close B-03 at home:**

1. **Quick fix (~30s + SSH script run)**: tell me which address you verified. SSH onto demo, append `SENDGRID_FROM_EMAIL=<verified-address>` to `backend/.env`, `pm2 restart globussoft-crm-backend --update-env`, re-run smoke test. Email lands. The reusable SSH-config skill (`.claude/skills/applying-demo-ssh-config/SKILL.md`) handles backup-and-rollback safety net.
2. **Better long-term (~10 min + DNS access)**: SendGrid → Settings → Sender Authentication → **Domain Authentication** for `crm.globusdemos.com`. Add the CNAME records SendGrid provides to your DNS (CNAME for `s1._domainkey`, etc.). After that, ANY `@crm.globusdemos.com` address (including `noreply@`) sends without per-address verification — and you get DKIM signing + better deliverability.

Path 1 is sufficient for demo; path 2 prevents the address from being a single-point-of-failure. Until B-03 ships, no email delivers from demo regardless of code.

### Closely-related smaller follow-up

**Cloudflare/Nginx swallows backend 502 body on /send-now** — the route at `routes/email_scheduling.js:302` returns `res.status(502).json({success: false, code: SENDGRID_REJECTED, detail: ...})` correctly, but the proxy stack returns its default 502 HTML error page to the client (curl saw `error code: 502` with no JSON body). Full error info IS persisted to `ScheduledEmail.errorMessage` so `GET /api/email-scheduling/:id` shows it — but the `/send-now` response itself is opaque. Worth a fresh `[regression]` issue against routes/email_scheduling.js — ~30 min fix once policy is decided (Nginx pass-through OR route returns 200 with success:false body).

### Open backlog at handoff

| Item | Status |
|---|---|
| **B-03** SendGrid Sender Identity | ⚠️ partial — see two paths above. Either share the verified address OR set up Domain Authentication. |
| **#431** Privacy retention silent-revert | ⬜ open — awaiting fresh repro from reporter |
| **#457** Manual-only QA umbrella | ⬜ open — intentional |
| **#523** responsive.css 11 brittle attribute selectors → class-based | ⬜ open — carry-over from v3.4.13/v3.4.14; PR #549 had a partial attempt that's now closed |
| **/send-now 502-body-swallowed-by-proxy** | ⬜ unfiled — see above; ~30 min |
| ~~**#534 follow-ups**~~ | ✅ resolved 2026-05-07 — profiled all 23 list endpoints cold against demo; zero exceed 0.5s. fb719e6's combination of (Patient/TreatmentPlan index adds) + (audit fire-and-forget on 11 list/detail handlers) addressed all 4 originally-reported endpoints. See [#534 follow-up comment](https://github.com/Globussoft-Technologies/globussoft-crm/issues/534#issuecomment-4391860457). |
| **#527 product-policy call** | ⬜ open — telecaller-can-read-all + professional-can-edit-any decisions need Rishu |

**Open PRs**: 0
**Operator-blockers**: B-03 (partial)

### Three things to do first at home

1. **Close B-03** — either tell me the verified address (path 1 — I'll do the SSH update + smoke test) OR set up Domain Authentication in SendGrid + DNS (path 2). After that, smoke-test confirms first-ever email delivery from demo since v3.4.13 SendGrid swap.
2. **File the smaller /send-now-502-body follow-up** as a fresh `[regression]` issue. ~30 min fix once filed.
3. **Pick from the open backlog** — #523 responsive.css refactor is the cleanest next class-fix (~2-3h, mechanical once a className scaffold is decided).

### Skills inventory (10, unchanged)

`adding-admin-trigger-endpoint`, `applying-demo-ssh-config` (used twice this session — for #524 SSH probe + the previous-session SendGrid env-var setup), `bumping-version-docs`, `capturing-wave-findings`, `dispatching-parallel-agent-wave`, `reporting-agent-progress`, `triaging-stuck-deploy-gate`, `verifying-issue-before-pickup` (5/6 of PR #549's claims = duplicates → applied Pattern E successfully), `wiring-spec-into-gate`, `writing-api-gate-spec`, `writing-vitest-unit-test`.

Earlier session arc (2026-05-06 day): v3.4.14 SAME-DAY PEN-TEST RELEASE — see superseded handoff below.

---


---
name: verifying-issue-before-pickup
description: Code-grep verification step before estimating or starting work on a GitHub issue or TODOS.md row. Issue framings drift — the implementation may already exist, the named function may already be wired, the "501 stub" may not be a 501 anywhere. Verifying first means the actual gap (often test-coverage, not implementation) gets fixed instead of duplicating shipped work. Runs in 2-5 minutes; saves hours of phantom-work agent runs. Especially critical before dispatching a parallel-agent wave — agent prompts narrow correctly when the parent agent has already verified.
---

# Verifying an issue before pickup

## When to use

Before estimating or starting on any GitHub issue, TODOS.md row, or carry-over drift finding. Triggers:

- User says "do #N" or "pick up #N"
- TODOS.md handoff names a P1/P2 to take next
- About to dispatch a parallel-agent wave on a batch of issues
- User asks "is X done?" and you're tempted to answer from memory

Skip when:
- The issue body is for genuinely greenfield work (no implementation could exist yet — e.g. "build a new /api/foo endpoint that doesn't exist")
- You authored the implementation in this same session and remember it precisely

## Why this matters — v3.4.8 + v3.4.9 wave incidents

The v3.4.8 wave dispatched 4 parallel agents on what TODOS.md framed as 4 distinct open issues. **3 of the 4** found the implementation was already shipped:

| Issue | TODOS framing | Actual gap |
|---|---|---|
| #180 | "Build session-revocation table (4-6h)" | RevokedToken model + jti claim + verifyToken lookup + POST /logout + GET/DELETE /sessions all shipped in v3.2.1 — only the per-push gate spec was missing |
| #398 | "Wire `sanitizeBody` middleware" | `sanitizeText()` (sanitize-html, allowedTags:[]) was already on POST + PATCH; only the regression-guard spec was missing |
| #443 | "GDPR DSAR export 501 stub (1-2 days)" | The file had no `501` anywhere — the actual gap was missing AuditLog rows on already-working endpoints + a legacy `action='EXPORT'` label vs canonical `'GDPR_EXPORT'` |

Each agent recovered by code-grepping the route file before writing code, but ~10 minutes per agent went to "diagnose what's actually wrong" instead of going straight to the real fix. **A 5-minute pre-dispatch verification by the parent agent would have narrowed each prompt accordingly** ("the route is already sanitized; just write the contract spec") and saved 30+ minutes of agent re-derivation.

**v3.4.9 reinforced the pattern with #167** — TODOS.md framed it as "Hard DELETE without audit (Contacts/Deals/Estimates/Tasks) — 4-5 days, ⬜ open, same audit-trail class as T2.2." Pre-dispatch grep revealed: every one of the 4 routes already implements soft-delete + AuditLog + a `/restore` companion endpoint. Each existing `*-api.spec.js` already has 14-17 `SOFT_DELETE`/`softDeleted`/`deletedAt`/`/restore` assertions. **#167 was fully closed**, including specs. The 4-5 day estimate would have been pure phantom-work; the parent agent caught this in 60 seconds via `grep -nE "router\.delete|writeAudit.*DELETE" backend/routes/{contacts,deals,estimates,tasks}.js`. **Saved a 4-agent dispatch.**

Combined v3.4.8 + v3.4.9 record: **4 of 8 issues** picked from TODOS.md were already done. That's a 50% doc-drift rate — high enough that pre-pickup verification should be the default for any TODOS row older than the most recent 1-2 release-bumps.

**v3.4.12+ extended the record: 5 of 6 GitHub-issue cluster (#505-#510) were not real or not reproducible** (only #509 was a real bug, fixed in 4 lines). The cluster filing pattern (one symptom → multiple sub-tickets attributing causes) inflates drift rate to 83%. See "Pattern E" below.

## Batch-sweep mode — proactive backlog hygiene (added 2026-05-05)

Same verification primitives as pre-pickup, **different trigger**: when the cron-driven autonomous loop is in "wave finished, user away, waiting on next CI" state, batch-verify the open backlog instead of going idle. The 2026-05-05 firing closed **5 issues in one cron tick** (4 verified-already-shipped + 1 small alias fix) by sweeping a sample of P1-P3 candidates: #191 (SECURITY brute-force), #167 (CRITICAL hard-DELETE), #182 (SMS queue), #402 (sidebar 404), #406 (stale URLs).

Cumulative: **8 stale closures across the v3.4.8 → v3.4.11 arc**, each backed by a triage comment citing implementing-commit + spec path + CHANGELOG line. Zero code regressions, all verified by the same grep checklist below.

When to invoke batch-sweep mode (vs pre-pickup):
- Cron firing finds wave already finished + skill/doc updates already shipped
- User-authorization queue is pending (tags / SSH ops / invasive design changes) and the user isn't responding yet
- CI on the most recent push is in_progress — there's a 5-15 minute window before the next decision point

How to scope a batch-sweep so it doesn't run forever:
- **Sample 5-10 candidates** by scanning `gh issue list --state open --limit 40` and picking the ones whose titles name a specific function / route / status code (those are the easiest to grep-verify; vague UX issues need fresh repro and don't drift-close cleanly).
- **Time-box at ~30 minutes**. If you've found 0 drift in the first 5 candidates, the batch is depleted — stop, don't keep grepping.
- **Skip P3 unless the title mentions a literal claim** (e.g. "X returns 404", "Y missing audit"). P3 cosmetic / UX framings usually need a UI repro, not a grep.
- **Save the time-budget for genuine fixes too** — the #406 alias fix in this firing took 5 minutes (2 `<Navigate>` lines mirroring an existing pattern). If a sweep candidate is genuinely open AND the fix is mechanical AND there's an existing pattern to clone, ship it inline rather than logging it for later.

What NOT to do during batch-sweep:
- **Don't close P2+ issues without a clear citation chain** (implementing-commit + spec + CHANGELOG). Patient/Lead/Audit retention (#431) reported 3 fields that don't exist in current code (5 entities); the right move was a triage comment requesting fresh repro, NOT a verified-shipped closure. GDPR/security/data-retention issues warrant the user-direction risk-aversion bias even in batch mode.
- **Don't sweep issues you authored in the same session.** Memory of recent work is enough.
- **Don't bundle drift findings into a code commit.** Each closure is its own `gh issue close` + comment. Code commits should be code; drift closures are tracker hygiene.

## The grep checklist (2-5 minutes)

Run before estimating or briefing any agent. Treat the issue body as a **hypothesis**, not ground truth.

### 1. Grep for the named claim

If the issue says "501 stub", grep `501` in the relevant file. If it says "missing endpoint X", grep for `router.<verb>('/X` or `app.<verb>('/X`. If it says "no validation on Y", grep for `Y` near `validate` / `sanitize` / `allowedTags` / `express-validator`.

```bash
# Issue: "GDPR DSAR is a 501 stub"
grep -nE "501|stub|TODO|not.implement" backend/routes/gdpr.js
# If empty → 501 framing is wrong. Read the file end-to-end to find the real gap.

# Issue: "Sequences accept HTML/JS"
grep -nE "sanitize|allowedTags|sanitizeHtml|stripDangerous|sanitizeText" backend/routes/sequences.js
# If sanitize-html is already wired → the real gap is test-coverage.

# Issue: "Build JWT revocation"
grep -lr "RevokedToken\|jti\b" backend/
# If multiple files match → revocation exists; check if a spec covers it.
```

### 2. Grep the test surface

Even when the implementation is shipped, the per-push gate may not cover it. That's a real gap (test-coverage gap) — but it changes the work shape from "implement + test" to just "test."

```bash
# Does any per-push spec hit the endpoint?
grep -rn "/api/auth/logout\|/api/auth/sessions" e2e/tests/ | head
# If empty → test-coverage gap. Spec is the work item.

# Does any vitest cover the helper / middleware?
ls backend/test/middleware/ backend/test/lib/
grep -rn "<helper-name>" backend/test/ | head
```

### 3. Grep recent CHANGELOG for hidden closes

Issues sometimes get closed in code without the issue tracker / TODOS.md being updated. The CHANGELOG is more reliable.

```bash
grep -nE "#NNN|<issue-keyword>" CHANGELOG.md
# If a recent vX.Y.Z entry mentions it as shipped → TODOS.md is stale.
```

### 4. Cross-check CLAUDE.md vs TODOS.md

When the two project docs disagree, **CLAUDE.md is more reliable** — it's edited at every release-bump and reflects the current version's deployed state. TODOS.md handoffs accumulate and get stale at the bottom.

For the v3.4.8 wave incident: CLAUDE.md said "JWT revocation shipped in v3.2.1"; TODOS.md said "open." Reality matched CLAUDE.md.

## The four common drift patterns

When verification surfaces a mismatch, it usually fits one of these:

### Pattern A — implementation shipped, spec missing

Most common (#180, #398). The route handler / middleware / engine already exists. The per-push gate has zero coverage of it. **Work item = write the spec, wire into deploy.yml + coverage.yml. Estimate often compresses 4-6h → 1-2h.**

### Pattern B — implementation shipped, audit/observability missing

Second-most common (#443, T2.2). The route works. The compliance-relevant audit row / logging / metric is missing. **Work item = add `writeAudit` / Sentry / metric calls + spec assertion that the row appears. Estimate often compresses 1-2 days → half a session.**

### Pattern C — partial fix, second bug not framed

#436 was framed as "where-clause bug" but turned out to be that PLUS another bug (uppercase status filter mismatch). The framing was directionally right but incomplete. **Work item = fix both. Spec must regression-guard both.**

### Pattern D — issue framing is just wrong

#443 said "501 stub" when there was no 501 anywhere. The real gap was elsewhere in the same file. **Work item = read the file end-to-end with the issue's intent as a hint, not a fact. Don't trust line numbers, function names, or status codes from the issue card without grep verification.**

### Pattern E — cluster-of-attributed-causes filed from a single symptom (added 2026-05-05)

QA observes one symptom (a toast firing on `/invoices` page-load) and files **multiple sub-issues attributing causes**: "the 503 backend bug" + "the no-backoff retry loop" + "the misleading toast text" + "the per-widget global-toast pattern" + "the wallet-extension noise." Each sub-issue is filed as if its attributed cause is observed fact. **Most of those attributed causes are speculation about the code, not verified diagnoses.** Verify each independently — they don't share a single root cause that, once fixed, closes them all.

The v3.4.12 #505-#510 cluster was the canonical case: 6 sub-tickets filed from one /invoices repro session. Reality check at HEAD `f489df1`:
- **#505/#506** (CRITICAL backend 503): not reproducible — all 4 endpoints + filter combos + burst tests + edge cases returned 200. Likely transient at QA's testing window.
- **#507** (infinite retry loop): doesn't match code. `Sidebar.jsx:181` polls every 60s in a `Promise.all` batch; `safeLen.catch(()=>null)` keeps previous count without retry; `fetchApi` doesn't auto-retry.
- **#508** (misleading "check your connection" toast on 503): doesn't match code. `utils/api.js:154` returns "Server error — please try again." on 5xx; "check your connection" only fires on no-response (line 128).
- **#509** (widget→global toast): **REAL.** Sidebar background polls were missing `{silent:true}` despite the api.js docstring at line 107 saying "Pages can opt OUT of the auto-toast by passing { silent: true }. Useful for background polls." 4-line fix (commit `8b747db`).
- **#510** (wallet-extension exceptions): not actionable on our side — third-party browser extension noise.

**5 of 6 = 83% drift rate.** Higher than the v3.4.8/9 50% baseline. The cluster filing pattern amplifies the rate because each sub-ticket is about an *attributed cause* that the QA didn't actually verify; only the *observed symptom* is real.

**Recipe for cluster-of-attributed-causes:**

1. **Find the one observed symptom.** Strip out attributions ("Caused by Bug 1", "Triggered by #505") — those are QA's hypothesis, not data. The symptom is "toast appeared on /invoices page-load," nothing more.
2. **Verify the symptom first.** If it doesn't reproduce, close ALL sub-tickets as not-reproducible. Don't waste agent-rounds investigating each attributed cause separately. The 5 v3.4.12 sub-tickets that closed without code change collectively saved ~6 agent-hours of phantom-work.
3. **If the symptom does reproduce, walk the symptom-to-cause path with grep**, not via the QA's attribution chain. Read `Sidebar.jsx`'s polling code first, then `fetchApi`'s error handling — DON'T jump from the issue body's "infinite retry loop" claim to an assumed retry-loop fix.
4. **Comment-and-close non-real sub-tickets with code citations**, not adjectives. "Closed — `Sidebar.jsx:181` polls every 60s with no retry; `safeLen.catch(()=>null)` keeps previous count without retry" is auditable. "Closed — not reproducible" alone invites re-opens.
5. **Keep the genuinely-real sub-ticket open and fix it.** #509 was the one real bug; closing it with a 4-line code change + commit-message `Closes #509.` trailer auto-closes via GitHub.

What this looks like in practice: 5 of 6 sub-tickets closed in ~10 minutes via curl + grep + 5 close-with-comment commands; the 1 real fix shipped in ~5 minutes (4-line edit + commit + push). Total: ~15 minutes for what would have been a 4-agent parallel wave on phantom causes.

## What to do when drift is found

1. **Note the drift in your final report** so it gets captured in CHANGELOG / TODOS handoff. Future sessions benefit from knowing TODOS row N was actually a test-coverage gap, not an implementation gap.
2. **Narrow the agent prompt** if you're about to dispatch. "The route is already sanitized; write a contract spec at e2e/tests/<area>-input-sanitization-api.spec.js per the writing-api-gate-spec skill" is much tighter than "wire sanitizeBody middleware." Saves the agent's re-derivation cycle.
3. **Update TODOS.md row** to reflect the real shape — but do this AFTER the fix lands, not before. Drift findings before implementation can be wrong; post-fix you know the real shape.
4. **Don't fix the doc instead of the code.** If the implementation is shipped but the spec is missing, the work is still real (test-coverage gap). Don't just close the issue — write the spec.
5. **Consider closing the issue with a triage comment** rather than a code commit if there's truly nothing to do. The 6 false-positive QA tickets in v3.4.7 (#295, #342, #404, #427, #428, #432, #442) are the canonical examples — verified via code-grep + live curl, closed with a detailed triage comment.

## Integration with other skills

- **`dispatching-parallel-agent-wave`** — run this verification on EACH issue in the planned batch before dispatching. The parent agent's 5-minute grep upfront saves 4× agents 10 minutes each (40 minutes total saved per 4-agent wave).
- **`capturing-wave-findings`** — when post-wave findings include "issue X was a doc-drift, not a real gap," route them to TODOS.md with the corrected shape so the next session doesn't re-derive.
- **`bumping-version-docs`** — the v3.4.8 CHANGELOG entry includes a "Doc-vs-reality drift surfaced" process note. Future bumps that have similar findings should call them out — it's a useful pattern for future-you reading old release notes.

## Pitfalls

- **Don't grep ONLY for keywords from the issue title.** "501 stub" might be in the body but the real gap is "missing audit row." Read the file end-to-end after the keyword grep returns empty.
- **Don't trust the issue's line numbers.** Files drift. The line cited in the issue may be at a different position now, or may have been deleted.
- **Don't skip verification because TODOS.md says "still open."** TODOS handoffs accumulate; the most recent CLAUDE.md is more authoritative than a TODOS row from 3 sessions ago.
- **Don't verify ONCE and dispatch 4 agents.** If the wave touches 4 different areas, verify each one — drift in different areas is independent.
- **Don't ship a spec that pretends the code was just written.** When the implementation pre-dates the spec by months, the spec's docstring should say so. The v3.4.8 specs all have headers like "Implementation already shipped in v3.2.1; this spec closes the per-push gate coverage gap." Honest framing makes the next reviewer faster.

## Quick verification template

For a TODOS row "**#NNN <subject>**":

```bash
# 1. What does the issue title say is missing/broken?
#    -> "501 stub", "build X table", "no audit on Y", "wire Z middleware"

# 2. Grep the literal claim
grep -nE "<keyword>" backend/<probable-file>.js

# 3. Grep the test surface
grep -rn "<endpoint-or-function>" e2e/tests/ backend/test/

# 4. Grep CHANGELOG for "shipped" mentions
grep -nE "#NNN|<keyword>" CHANGELOG.md | head

# 5. Decide:
#    - Pattern A (impl shipped, spec missing) -> writing-api-gate-spec
#    - Pattern B (impl shipped, audit missing) -> add writeAudit calls + spec
#    - Pattern C (partial fix, second bug) -> fix both
#    - Pattern D (framing wrong) -> read file end-to-end, find actual gap
#    - True open (impl absent) -> standard implementation + spec
```

5 minutes of grep saves 30+ minutes of re-derivation per agent.

## Apply to multi-day flagships, not just GitHub issues (added 2026-05-06)

Same pre-flight grep applies to any TODOS.md row that frames the work as **"set up X"**, **"stand up Y"**, **"bootstrap Z"**, or any fresh-greenfield assumption. The estimate is usually wrong because some non-zero amount of the infrastructure already exists.

The 2026-05-05 G-21 incident was the canonical case: TODOS estimated "Frontend vitest + RTL coverage expansion" at 3-5 days for several sessions. Agent D shipped it in ~10 minutes of real work because:
- vitest infrastructure was already in `frontend/vite.config.js` from earlier waves (`f752c85` Mar 2026 + `6e66845` Apr 2026)
- 18 test files already existed
- The actual gap was just (a) wire the existing tests into a CI gate (didn't exist on per-push), (b) fix 3 stale failing tests pinned to pre-#343 contracts, (c) add 6 new test files for under-covered surfaces

The 3-5 day estimate was based on "greenfield setup from zero." The real work was a 30-minute config + spec round.

**Pre-flight grep checklist for "set up X" rows:**

```bash
# 1. Does X already exist anywhere?
grep -rn "<framework-name>" <project-area>/   # e.g. "vitest" frontend/, "playwright" e2e/

# 2. Does any test infrastructure already exist?
find . -name "*.test.*" -o -name "*.spec.*" | head -20

# 3. Does the project already have config?
ls <project-area>/*.config.* <project-area>/*.json | head

# 4. Was X (or its predecessors) installed but never wired to CI?
grep -lE "<framework>" .github/workflows/*.yml
```

If grep returns matches → re-frame the row from "set up X" to "wire existing X into CI" or "extend existing X coverage." Estimate compresses dramatically (days → hours typically).

**Don't trust the estimate on a TODO row that's been carrying the same `multi-day flagship` label for 3+ session-handoffs.** Multi-session-stale flagship rows are exactly the rows where the original "needs to be set up" framing has drifted — the infrastructure was likely added incrementally during unrelated work.

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

## Why this matters — v3.4.8 wave incident

The v3.4.8 wave dispatched 4 parallel agents on what TODOS.md framed as 4 distinct open issues. **3 of the 4** found the implementation was already shipped:

| Issue | TODOS framing | Actual gap |
|---|---|---|
| #180 | "Build session-revocation table (4-6h)" | RevokedToken model + jti claim + verifyToken lookup + POST /logout + GET/DELETE /sessions all shipped in v3.2.1 — only the per-push gate spec was missing |
| #398 | "Wire `sanitizeBody` middleware" | `sanitizeText()` (sanitize-html, allowedTags:[]) was already on POST + PATCH; only the regression-guard spec was missing |
| #443 | "GDPR DSAR export 501 stub (1-2 days)" | The file had no `501` anywhere — the actual gap was missing AuditLog rows on already-working endpoints + a legacy `action='EXPORT'` label vs canonical `'GDPR_EXPORT'` |

Each agent recovered by code-grepping the route file before writing code, but ~10 minutes per agent went to "diagnose what's actually wrong" instead of going straight to the real fix. **A 5-minute pre-dispatch verification by the parent agent would have narrowed each prompt accordingly** ("the route is already sanitized; just write the contract spec") and saved 30+ minutes of agent re-derivation.

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

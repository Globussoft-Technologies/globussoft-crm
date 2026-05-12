---
name: batch-closing-issues-after-multi-fix-commit
description: Post-push verification + batch close-out for commits with multiple `Closes #N` trailers. GitHub silently caps auto-close behaviour — shortform `Closes #A #B #C` only fires for the first; even one-per-line trailers cap at ~6. Encodes the verify-loop + citation-comment template + decision tree (amend vs manual close) so the wrap-up after a multi-fix bundled commit doesn't leave issues open. Confirmed dozens of times across 2026-05-05 / 2026-05-12 waves.
---

# Batch-closing issues after a multi-fix commit

## When to use

You just pushed a commit that has multiple `Closes #N` trailers (typically because a wave-agent bundled N fixes into one commit per the `dispatching-parallel-agent-wave` skill's "1 commit covering all N fixes" rule).

Check whether GitHub actually auto-closed every issue. **Spoiler: it usually didn't.**

## The two silent failure modes

### Failure mode 1 — Shortform `Closes #A #B #C` only auto-closes the FIRST

Per GitHub's grammar, the closing keyword must immediately precede each `#N`. The commit body:

```
Closes #685 #686 #687 #688
```

Only auto-closes #685. The keyword "Closes" doesn't carry over.

**Mitigation in the commit:** use one `Closes #N` per line. The body should look like:

```
Closes #685.
Closes #686.
Closes #687.
Closes #688.
```

Or use the `Refs:` pattern + manual close:

```
Refs #685 #686 #687 #688 — see per-issue rationale below.
```

### Failure mode 2 — Per-commit auto-close CAP

Even when every trailer is correctly formatted (one `Closes #N` per line), commits with 5+ trailers silently cap. Multiple confirmed instances:

- 2026-05-05 Agent J's `ecb4ae0` had 7 `Closes #N` lines; only 6 fired (#476 stayed OPEN).
- 2026-05-05 Agent I's `fc9898e` had #465 + #473 stay OPEN despite explicit trailers.
- **2026-05-12 all-issues-sweep:** Wave D1 / D2 / D3 commits each had 4-8 `Closes #N` lines; the trailer cap left 14 issues open across the three commits. Required a batch manual close-out.

There's no documented limit and the behavior may be intermittent (rate-limit on the close-on-commit hook). **Treat the cap as load-bearing — always verify after multi-issue commits.**

## The verify-and-close loop

Run immediately after `git push`:

```bash
# Extract all issue numbers from the commit message body
COMMIT_SHA="$(git rev-parse HEAD)"
ISSUES=$(git log -1 --format=%B "$COMMIT_SHA" | grep -oE '#[0-9]+' | tr -d '#' | sort -u)

# Verify each
for n in $ISSUES; do
  state=$(gh issue view "$n" --json state --jq '.state')
  echo "#$n: $state"
done
```

For each issue still showing `OPEN`, run the manual close with a citation comment:

```bash
gh issue close <N> --reason completed --comment "$(cat <<'EOF'
Shipped in commit <SHA> — <one-line summary of what landed>.

<file:line citation OR which test pins the contract>

Auto-close trailer didn't fire (multi-issue commit hit GitHub's cap — see CLAUDE.md standing rule on the trailer behaviour). Closing manually.
EOF
)"
```

## Citation comment template

The comment is load-bearing for the post-mortem audit trail. It serves THREE purposes:

1. **Traceability:** future readers can find what fixed the issue by clicking the linked commit
2. **Phantom-prevention:** if the symptom recurs, the next reporter sees "the fix shipped at X" and verifies against current code BEFORE re-filing
3. **Test pin:** the test that proves the fix landed (so a regression that re-opens the issue will go red)

Minimum content:

```markdown
Shipped in commit `<SHA>` — <one-line description>.

**Evidence:** `<file>:<line>` (or `<file>` if the change is structural).

**Pinned by:** `e2e/tests/<spec>.spec.js` / `backend/test/<test>.test.js` (the test that catches a regression).

[Auto-close trailer didn't fire — multi-issue commit hit GitHub's cap. Closing manually as part of the post-push wrap-up.]
```

If the close is a **phantom-carry-over** (issue was reporting a symptom of already-shipped code, not a missing feature), expand the comment to include the phantom rationale:

```markdown
Verified-shipped per the YYYY-MM-DD phantom audit.

**Evidence:** <file:line> + commit <SHA> citation.

<2-3 sentence context: what code is live, what the symptom likely reflects, what to verify if the symptom recurs against current demo>

If the symptom genuinely recurs against demo (running vX.Y.Z), please re-file with a fresh screenshot + the URL where it appears + the role you were logged in as.
```

## Decision tree — amend vs manual close

After verifying which issues didn't auto-close, you have two paths:

| Situation | Path |
|---|---|
| Commit not yet pushed (still local) | Amend the commit message — restructure `Closes #N` trailers to one-per-line, keep total ≤ 4 |
| Already pushed; ≤ 2 issues missed | **Manual close** with citation comment per issue |
| Already pushed; > 2 issues missed | **Manual close** in a batched loop (see below) |
| Mix of phantoms and real fixes | Use separate comment templates per category |

**Don't `--force-push` an amend just to fix trailer formatting.** The history-rewrite cost (broken hash references in PR comments, broken links in CHANGELOG) outweighs the convenience of auto-close.

## Batched manual-close loop

For the common case of 4+ issues to close from one commit, write a small bash loop with per-issue customised comments:

```bash
declare -A COMMENTS=(
  [685]="<citation A>"
  [686]="<citation B>"
  [687]="<citation C>"
  [688]="<citation D>"
)

for n in "${!COMMENTS[@]}"; do
  gh issue close "$n" --reason completed --comment "Shipped in commit \`<SHA>\` — ${COMMENTS[$n]}

Auto-close trailer didn't fire (multi-issue commit hit GitHub's cap). Closing manually as part of the post-push wrap-up." 2>&1 | head -1
done
```

The `2>&1 | head -1` keeps the output tight so you can see at-a-glance which closures landed.

## Pitfalls

### Pitfall 1: "Closes #N" vs "Closed by #N" vs "Fixes #N"

GitHub recognises the keywords: `close / closes / closed / fix / fixes / fixed / resolve / resolves / resolved`. Plus a few legacy variants. But there's no guarantee these all behave identically under the cap — `Closes` is the most-reliable; the others may degrade earlier.

### Pitfall 2: Issue body has its own `#N` reference

If your commit body says `Closes #689 (relates to #555)`, GitHub may try to close #555 as well. Usually it's smart enough to ignore non-keyword-preceded numbers, but cross-repo references (`org/repo#N`) are particularly flaky.

### Pitfall 3: Issue is in a different repo

`Closes Globussoft-Technologies/globussoft-crm#689` works for cross-repo but takes a different code path on GitHub's side and is more prone to silent cap behaviour. Always use the bare `#N` form for same-repo issues.

### Pitfall 4: Re-opening a previously-closed issue accidentally

If the issue was already closed (e.g. by an earlier commit or a manual close), `gh issue close` returns a warning but doesn't error. Don't trust the warning to surface — re-verify state after the batch loop:

```bash
for n in 685 686 687 688; do
  echo -n "#$n: "; gh issue view "$n" --json state --jq '.state'
done
# All should report CLOSED.
```

## Related

- `dispatching-parallel-agent-wave/SKILL.md` — the "Verify each issue's auto-close after multi-issue commits" section that motivated this skill. This skill extracts + extends that material so it's discoverable for non-wave commits too (a single-agent commit with multiple `Closes #N` can hit the cap too).
- `auditing-cross-cutting-spec-impact/SKILL.md` — when the commit changes a public shape, the cross-cutting audit must run BEFORE the multi-fix bundle. If the audit catches missed test pins, the commit grows and the trailer count grows — pay even more attention to the verify-loop afterwards.

---
name: capturing-wave-findings
description: Routes agent-discovered findings (bugs, contract drift, shipped specs, route gaps, standing-rule violations) into the correct doc(s) — TODOS.md, docs/E2E_GAPS.md, CHANGELOG.md, CLAUDE.md, or a new GitHub issue — so nothing surfaced mid-wave is lost between waves. Invoke at the END of every parallel-agent wave (orchestrator) or at task FINISH (individual agent that surfaces something out-of-scope). Without this, drift findings sit in chat history and evaporate when context compacts.
---

# Capturing wave findings

## Why this exists

Parallel-agent waves surface a lot of incidental knowledge:
- "I added the spec for X but noticed engine Y has a bug Z"
- "Route /foo is missing GET /:id"
- "Pattern A is fragile; suggest adding a CLAUDE.md rule"
- "While doing the assigned task, I shipped sub-task B as a bonus"

If the orchestrator doesn't immediately route these into a doc, they
live only in chat history. When context compacts, they vanish. The
next wave then **rediscovers the same drift** or worse, ships work
that conflicts with a finding nobody acted on.

This skill defines a small classification + routing protocol so
EVERY finding lands in EXACTLY ONE durable place by the end of the
wave.

## When to invoke

- **At the end of every parallel-agent wave** (orchestrator) — collate
  all agent reports, run this skill once over the combined finding
  list, ship a single `docs(findings): wave N capture` commit.
- **At task finish** (individual agent) — if your work surfaced
  something out-of-scope that you didn't fix yourself, log it via this
  skill BEFORE you mark the agent done. Do NOT silently drop it into
  the final report and hope the orchestrator notices.

## The taxonomy — 6 finding types

Each finding falls into exactly ONE of these. If two routings seem
to apply, pick the higher-leverage one (issue > doc; durable > ephemeral).

| Type | Example | Lands in |
|---|---|---|
| **Bug** | "engine X writes wrong status" | New GitHub issue + TODOS.md "Long tail" line |
| **Contract drift** | "POST /foo returns 200 but spec contract says 201" | New GitHub issue + TODOS.md "Long tail" line |
| **Missing route surface** | "routes/X.js has POST + GET but no GET /:id" | New GitHub issue OR existing TODOS gap; if cross-cutting (≥3 routes affected), new G-XX row in E2E_GAPS.md |
| **Spec / coverage shipped** | "shipped foo-api.spec.js, 42 tests" | E2E_GAPS.md row ✅ + bullet under in-progress CHANGELOG entry |
| **Standing-rule pattern** | "every new spec hits this footgun; suggest adding rule" | CLAUDE.md "Standing rules for new code" addendum |
| **New backlog item** | "discovered we have zero tests for area Z" | New G-XX row in docs/E2E_GAPS.md priority backlog |

If a finding doesn't match ANY of these, it's probably not worth
durable capture — note it in the wave summary and move on.

## The routing — what to do for each type

For each finding, perform the matching action set:

### 1. Bug or contract drift
Both end up in the same place: a new GitHub issue + a one-line entry
in TODOS.md "Long tail still open". Use the bundled helper:

```bash
.claude/skills/capturing-wave-findings/capture.sh issue \
  --type bug \
  --title "engine X writes wrong status (closes #NNN)" \
  --area cron \
  --severity P2 \
  --body-file /tmp/finding-1.md
```

The script:
1. Posts the issue via `gh issue create` with labels (`type:bug`, `severity:P2`, `area:cron`, `surfaced-by:wave-N`)
2. Appends a one-liner to TODOS.md "Long tail still open" section
3. Returns the issue URL on stdout

### 2. Missing route surface (single route)
Same as above but `--type contract-drift`. Body should include:
- The route path + method that's missing
- Why it matters (the spec that was forced to use a workaround, etc.)
- Suggested fix (1-3 lines)

### 3. Missing route surface (cross-cutting, ≥3 routes)
Don't file an issue per route — open ONE umbrella issue and add a
new **G-XX** row to docs/E2E_GAPS.md. Use the helper:

```bash
.claude/skills/capturing-wave-findings/capture.sh backlog-row \
  --id G-26 \
  --title "non-numeric :id sweep — handlers crash on /resource/abc" \
  --effort 1d \
  --risk Med \
  --body-file /tmp/finding.md
```

The script:
1. Inserts a new row at the right spot in docs/E2E_GAPS.md priority backlog table
2. Files the umbrella issue with a list of affected routes
3. Adds an entry to TODOS.md with the issue link

### 4. Spec / coverage shipped
Mark E2E_GAPS.md row ✅ and add a CHANGELOG bullet. Use the helper:

```bash
.claude/skills/capturing-wave-findings/capture.sh spec-shipped \
  --gap-id G-26 \
  --commit a1b2c3d \
  --tests 42 \
  --note "rename-on-cleanup pattern; surfaced #428"
```

The script:
1. Edits docs/E2E_GAPS.md — finds the `| **G-26** | ... | ⬜ open |` row and replaces with `✅ shipped (a1b2c3d — 42 tests; rename-on-cleanup pattern; surfaced #428)`
2. Appends a bullet under the in-progress CHANGELOG.md `## [Unreleased]` section, or under the most recent dated section if no Unreleased exists

If there's no E2E_GAPS row (the spec was off-backlog), pass
`--gap-id off-backlog` and the script just updates CHANGELOG.

### 5. Standing-rule pattern
This needs human review — don't auto-edit CLAUDE.md. Instead, add the
proposal to TODOS.md under a new section "🟡 Proposed standing-rule
additions (review before next session)":

```bash
.claude/skills/capturing-wave-findings/capture.sh rule-proposal \
  --rule "every new spec under e2e/tests/ MUST end with afterAll cleanup, even if RUN_TAG cleanup ran" \
  --reason "two waves in a row tripped on residue from helper Locations created in beforeAll" \
  --evidence "02a4d1e + 967cbdc"
```

The script appends the proposal verbatim. The orchestrator (or user)
promotes it to CLAUDE.md "Standing rules for new code" in a
follow-up commit ONLY if confirmed.

### 6. New backlog item (discovered gap)
Same path as #3 (cross-cutting route gap) — new G-XX row in
docs/E2E_GAPS.md. Use the same `backlog-row` mode of the helper.

## End-of-wave protocol

After a wave finishes:

1. Collate findings from every agent's final report into a list. Use
   the chat to draft, but commit nothing yet.
2. Classify each finding into ONE of the 6 types.
3. For each finding, run the matching `capture.sh` mode (or edit by
   hand if the finding is unusual).
4. Run `git status` — verify only TODOS.md / docs/E2E_GAPS.md /
   CHANGELOG.md changed (plus any new issues filed via `gh`, which
   don't touch the working tree).
5. Single commit: `docs(findings): wave N capture — N issues filed,
   M backlog rows updated`. Push. The next wave starts with a
   complete picture.

## Idempotency

The script is idempotent in the cheap cases:
- `spec-shipped` — if the row is already ✅, refuse and exit 0
- `backlog-row` — if the G-XX id already exists, refuse and exit 1 (you picked a colliding id)
- `issue` — always files a fresh issue (gh has no built-in dedup); the orchestrator should de-dupe BEFORE calling
- `rule-proposal` — appends every time; this is intentional (multiple proposals stack)

## What NOT to capture

- **Agent-internal flow notes** — "I read file X, then file Y, then..." Not durable. Belongs in agent's final report only.
- **Stack traces / full error logs** — too long. One-line summary in the issue body, link to CI run if applicable.
- **Comments on the orchestrator's prompt** — "your instructions said X but I think Y." That's chat feedback, not a durable finding. Reply in the report.
- **Self-praise** — "this was tricky but I got it." Skip. The diff speaks.

## Anti-patterns to flag during classification

If you find yourself reaching for a 7th type, you're probably:
- **Confusing two findings into one** — split them
- **Trying to route a non-actionable observation** — drop it
- **Avoiding the existing TODOS.md "Long tail" because the wording feels too informal** — use it anyway; consistency > polish

## Integration with `dispatching-parallel-agent-wave`

Update the orchestrator section of that skill to reference this one:
> After all per-agent reports are in, run `capturing-wave-findings`
> over the combined finding list before tagging or doc-bumping.
> Otherwise next wave's agents may rediscover the same drift.

## Where the user reads what landed

- New issues: GitHub issue list, filtered by `surfaced-by:wave-N` label
- TODOS.md "Long tail still open" + the wave's handoff block
- docs/E2E_GAPS.md priority backlog table (✅ shipped column)
- CHANGELOG.md in-progress entry (the orchestrator's `bumping-version-docs` skill picks this up at release time)

---
name: reporting-agent-progress
description: Posts an agent-activity log entry so the user can watch background agents progress in real time via the CRM's Developer page (/developer). Use at the START of any non-trivial task (gate-spec authoring, vitest writing, engine fix, parallel-wave dispatch), at major MILESTONES (after a commit lands, after a wire-in step finishes), and at FINISH (success or failure). The user has the Developer page open polling every 3 seconds; entries appear there immediately. Without this, parallel waves are opaque to the user — they only see the final report when the agent finishes. With it, they see start / commit / done in real time.
---

# Reporting agent progress

## Why this exists

Parallel-agent waves are opaque to the user — they only get a notification when each agent FINISHES, not while it's working. With 4-8 agents in flight, the user has no visibility into what each is doing right now: stuck on a route file? Past the test-write phase? Pushing the commit?

This skill defines a tiny logging protocol every agent should follow. Entries land in `.scripts-state/agent-activity.jsonl` and surface immediately on the CRM's `/developer` page, which polls `GET /api/developer/agent-activity` every 3 seconds.

## When to log

- **At task start** — before reading any files. `action: 'start'`, `message: <one-line task summary>`.
- **At major milestones** — after spec is green; after vitest passes; after wire-in succeeds; before each commit. `action: 'milestone'`, `message: <what just finished>`.
- **At commit** — immediately after each `git commit`. `action: 'commit'`, `commit: <sha>`, `file: <main file touched>`, `message: <commit subject>`.
- **At task finish** — success or failure. `action: 'done'` or `action: 'failed'`, plus a one-line summary.

Do NOT log every step (don't spam — the page polls every 3s; one entry per ~30s of work is right). DO log enough that the user can see forward progress.

## The protocol

Every entry is a POST to `/api/developer/agent-activity` (admin-only) with body:

```json
{
  "agent": "<your-task-tag>",       // required, ≤80 chars (e.g. "G-12-campaign-engine", "R-4-booking-pages")
  "action": "<event>",              // required: start | milestone | commit | done | failed | ...
  "file": "<primary-file>",         // optional: main file being edited (e.g. "e2e/tests/foo-api.spec.js")
  "commit": "<sha>",                // optional: full or short SHA, only on action='commit'
  "status": "<short-status>",       // optional: green | red | flaky | etc.
  "message": "<one-line>"           // optional: ≤500 chars freeform
}
```

You'll need an admin token. The orchestrator's seeded login works:
```
admin@globussoft.com / password123
```

## Easy invocation — bundled helper

Use the bundled `log.sh` script (also at `.claude/skills/reporting-agent-progress/log.sh`):

```bash
.claude/skills/reporting-agent-progress/log.sh \
  --agent "R-4-booking-pages" \
  --action "start" \
  --message "writing e2e/tests/booking-pages-api.spec.js, cloning landing-pages-api pattern"
```

The script:
1. Logs in as `admin@globussoft.com` (cached per-run via tmpfile)
2. POSTs the JSON entry to `http://127.0.0.1:5000/api/developer/agent-activity`
3. Falls back to appending directly to `.scripts-state/agent-activity.jsonl` if the backend is down (so the agent never fails on log failure)

## Example invocation pattern (R-4 spec agent)

```bash
TAG="R-4-booking-pages"
LOG=".claude/skills/reporting-agent-progress/log.sh"

# Start
$LOG --agent "$TAG" --action "start" --message "writing booking-pages-api.spec.js, cloning landing-pages pattern"

# After reading the route + reference spec
$LOG --agent "$TAG" --action "milestone" --message "route read; 9 endpoints, 14-day public-window contract"

# After spec is green locally
$LOG --agent "$TAG" --action "milestone" --message "spec green: 43 tests, 18.1s on local stack"

# After commit
$LOG --agent "$TAG" --action "commit" --commit "$(git rev-parse HEAD)" --file "e2e/tests/booking-pages-api.spec.js" --message "test(api): booking-pages-api gate (R-4)"

# After wire-in
$LOG --agent "$TAG" --action "milestone" --message "wired into deploy.yml + coverage.yml"

# At finish
$LOG --agent "$TAG" --action "done" --status "green" --message "shipped 43 tests, 1 contract drift flagged for separate issue"
```

## Naming convention for `agent`

Use a short stable identifier the user can grep for. Pattern: `<gap-id-or-batch>-<area>`. Examples:
- `G-12-campaign-engine`
- `G-20-w3-tenant-isolation`
- `R-4-booking-pages`
- `R-5-forecastSnapshotEngine`
- `engine-fix-410`
- `heal-loop-post-wave`
- `discovery-2026-05-04`
- `orchestrator` (the parent agent's tag, when it's logging its own actions)

## What NOT to log

- **Not** internal "I'm reading file X" steps. Too noisy.
- **Not** every test result. The "spec green" milestone covers it.
- **Not** PII or secrets. The `message` field is shown in cleartext on the Developer page.
- **Not** stack traces. Too long. Summarise to one line; full traces go in the agent's final report.

## What if the backend isn't up?

The `log.sh` script falls back to appending directly to the JSONL file. The Developer page reads from the file via the backend route, so when the backend comes back up, the entries will surface. Agents should ALWAYS log — never skip because of a backend hiccup.

## Where the user reads it

`https://crm.globusdemos.com/developer` (or `http://localhost:5173/developer` if running Vite locally) — Developer page has a "Live agent activity" widget at the top, polling every 3 seconds. Newest entries first. Color-coded by `action` (start = blue, done = green, failed = red).

## Integration with `dispatching-parallel-agent-wave`

Update every per-agent prompt template in `.claude/skills/dispatching-parallel-agent-wave/AGENT_PROMPT_TEMPLATE.md` to include:

```
## Progress reporting

Use the reporting-agent-progress skill — log start, milestone(s), commit, and done events via:
.claude/skills/reporting-agent-progress/log.sh

Tag yourself as "<agent-tag>" so the user can identify your activity in /developer.
```

That makes the reporting habit baked into the dispatch.

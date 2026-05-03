# CHANGELOG entry — template

Insert at the TOP of `CHANGELOG.md`, above the previous entry. Replace `vX.Y.Z`, the date, the subject, and the section bodies.

```markdown
## vX.Y.Z — YYYY-MM-DD — <one-line subject summarising the wave>

<One paragraph framing: what kind of release this is (continuation arc /
focused feature / multi-day investment / bug-fix sweep). Mention "No
new product features" if the bump is purely test-infra or docs.>

### Test surface continued growth

| Tier | Tool | vX.Y.(Z-1) | vX.Y.Z | Delta |
|---|---|---|---|---|
| Per-push API tests | Playwright | A specs / B tests | **C specs** / D tests | +(C-A) specs / +(D-B) tests |
| Per-push unit tests | vitest | E files / F tests | **G files** / H tests | +(G-E) files / +(H-F) tests |
| **Total per-push** |  | (B+F) | **(D+H)** | **+N%** |

### Added — <category 1, e.g. "N new gate specs">

| ID | Spec | Commit | Tests | Notable |
|---|---|---|---|---|
| **G-X** | `<area>-api.spec.js` | `<sha>` | NN | <one-line: what's tested + any contract drift surfaced> |

<Repeat the table for each category that got additions: gate specs, vitest files, route refactors, etc.>

### Fixed — <category, e.g. "N compliance bugs closed">

- **#NNN closed** (commit `<sha>`) — <root cause + fix in one paragraph>

### Bonus fixes shipped en route

- **<infra fix surfaced by an agent during their primary work>** — <what + why it matters>

### <Optional sections per release>

- **Spec-discipline cleanups** — for spec maintenance work
- **Schema findings** — when G-24 surfaces drift worth recording
- **Operations** — for cron cadence changes, demo-cleanup automation, etc.

### Carry-over for vX.Y.Z+1

- **Outstanding contract-drift findings worth filing** as separate `[regression]` issues:
  - **#NNN (proposed)** — <description>
- **<gap-id>** — <one-line + effort estimate>
- **<gap-id>** — <one-line + effort estimate>
- ...
```

## Section conventions

- **"Added — ..."** is the meat. Use a table (one row per spec) for ≥3 additions, bullets for 1-2.
- **"Fixed — ..."** is for issues with GitHub numbers. Always reference the issue number (`#NNN closed`).
- **"Bonus fixes shipped en route"** captures infra wins agents stumbled on while doing their primary work. Examples from past entries: vitest.config.js cron/ deps.inline gap (engine-fixes agent fixed it on the way to closing #410/#411); ENTITY_MAP eager-binding refactor (same agent).
- **"Carry-over for vX.Y.Z+1"** is the planning bridge to next session. Lists what's still open + which findings should be filed next.

## What NOT to put in the entry

- Step-by-step playbook for HOW the work was done — that's the SKILL.md or PR description's job.
- Marketing language ("This release is exciting because..."). Keep it factual.
- Long quotes from agent reports. Distil to one sentence per finding.
- Names of contributors / agent IDs. Use "the agent" or skip; commits attribute via SHA.

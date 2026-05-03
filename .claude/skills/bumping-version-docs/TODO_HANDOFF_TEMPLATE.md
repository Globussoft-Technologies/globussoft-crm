# TODOS.md 🏁 handoff block — template

Replace the existing 🏁 block at the top of `TODOS.md`. The previous handoff's content moves into a one-line "Earlier session notes" footnote a few paragraphs down.

```markdown
---

## 🏁 NEXT-SESSION HANDOFF (YYYY-MM-DD <morning|afternoon|night|late-night> — <subject>)

**HEAD on origin/main:** `<sha>`. Per-push gate ✅ GREEN. Live on demo.

### Why this session

<One paragraph: what triggered this round of work — user request, audit
follow-through, scheduled cadence, etc. Names what was fixed/added at
a high level.>

### What shipped this session (N commits, all CI-green)

| Commit | What | Closes |
|---|---|---|
| `<sha>` | **<verb-led one-liner>** | #NNN |
| `<sha>` | **<verb-led one-liner>** | #NNN |
| ... |

### Issues closed this session

- ✅ #NNN <subject> (commit `<sha>`)
- ✅ #NNN <subject> (commit `<sha>`)

### Per-push gate state (post this session)

~N specs / **~A tests** + M vitest files / **~B unit tests** = **~(A+B) tests on every push**, all green. Live on demo at `<sha>`.

### Three things to do first next session

1. **<verb-led action>** — <one-paragraph why + how to start>

2. **<verb-led action>** — <one-paragraph>

3. **<verb-led action>** — <one-paragraph>

### Long tail still open

- #NNN — <one-line>
- #NNN — <one-line>
- T2.x — <one-line + effort estimate>
- G-x — <one-line + effort estimate>

---
```

## Conventions

- **"Three things to do first"** is the ask. Pick the highest-leverage three. Avoid five-or-more — readers stop at three.
- **"Why this session"** is forensic context — what triggered the work. Useful when you pick up six months from now.
- **"What shipped"** is a commit-by-commit table. SHAs are clickable in GitHub.
- **"Issues closed"** is GitHub-issue-numbered list. Different from "What shipped" — closes can come from multiple commits, ships can be multiple per issue.
- **"Per-push gate state"** is the at-a-glance health metric.
- **"Long tail still open"** lists 5-15 items. Don't dump the whole backlog — pick the items most relevant to picking up where this session left off.

## What NOT to include in the handoff block

- Detailed implementation notes. Those go in the commit messages or the SKILL.md if reusable.
- The full E2E_GAPS.md backlog. Reference it; don't duplicate.
- Praise / commentary on what went well. Keep factual; readers want orientation, not a recap of the session's vibe.
- Specific timing ("we worked on this from 9pm to 1am"). Doesn't help future-you.

## Footnote pattern for the previous handoff

After replacing the block, add ONE line at the end of the new block:

```markdown
Earlier session arc (YYYY-MM-DD): <one-line summary linking to
the previous CHANGELOG entry or commit hash>.
```

If you have multiple "earlier" sessions to point to, list them oldest → newest in a single paragraph. Don't keep more than 3 days of handoff history inline; older context lives in CHANGELOG.

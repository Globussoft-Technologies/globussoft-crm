# Closed gap-files archive

This directory holds gap / backlog / regression-tracking files that are
**fully closed** — every item shipped, no pending entries. We keep them
under version control (rather than deleting) for historical context:
when a future incident or audit needs to know "did we ever have a spec
for X?", the archived file answers it.

## What goes here

A gap-file is **archivable** only when ALL of the following are true:

1. Every entry in the file is marked ✅ / ☑ / DONE / shipped.
2. There are no `⬜` / `☐` / `TODO` / `open` markers anywhere in the file.
3. The file has no "future work" or "deferred" sub-section that is
   still load-bearing.

If even one item is open, **the file stays in its original location**
(`docs/` or repo root). Don't be tempted to "split" a file just to
archive the closed half — the cohesion of the original file is more
useful than archive cleanliness.

## What does NOT go here

- **Active backlogs with mostly-closed items** — e.g.,
  `docs/E2E_GAPS.md` with 6 open rows out of 27. Stays at `docs/`.
- **Historical context that lives inside an active file** — e.g.,
  the "superseded above" handoff blocks in `TODOS.md`. Those are
  scrollback, not separate files; leave them where they are.
- **CHANGELOG.md or release notes** — those are append-only by design
  and never get archived.

## How to archive a gap-file

When you ship the last open item in a gap-file:

```bash
# Verify zero open markers remaining
grep -cE '⬜|☐|TODO|open' docs/<file>.md   # must return 0

# Move (preserves git history via --rename)
git mv docs/<file>.md docs/gaps/archive/<file>.md

# Add a closure note at the top of the archived file
# (see template below)

git commit -m "docs(archive): <file>.md — all items shipped, moving to archive"
```

## Closure-note template

When archiving, prepend this block at line 1 of the file:

```markdown
> **ARCHIVED — fully closed YYYY-MM-DD**
>
> All items in this file shipped. Last entry closed by commit `<sha>`
> (`<short-description>`). Kept here for historical reference; do not
> add new items — open a fresh tracking file at `docs/<new-name>.md`
> instead.
```

## Why this convention exists

Gap files accumulate. Without an archive convention, the repo root
fills with stale "TODO_FOO.md" files that engineers have to mentally
filter every session. Moving fully-closed files here keeps the active
backlog discoverable without losing the audit trail.

## Pointer in CLAUDE.md / TODOS.md

The repo's `TODOS.md` (read at session start per `CLAUDE.md`) and
`CLAUDE.md` itself reference this archive so newcomers know where
closed gap-files live.

# Handoffs archive

This folder holds **session-boundary handoff documents** and dated
TODO files from prior work cycles. They're kept (not deleted) for two
reasons:

1. **Historical reconstruction.** "Why did we ship X on date Y" is
   sometimes only answerable by reading the handoff written that day.
2. **Pattern mining.** Some handoffs surface non-obvious gotchas that
   the regular CHANGELOG / commit log doesn't capture (e.g. "wave
   M tried approach A, found it red, switched to B"). Searchable
   context for future engineers.

## Convention

- Active handoff / TODO for the **current** session lives at
  `docs/` root (e.g. `docs/HANDOFF-2026-05-14-evening.md`).
- When the next session starts and writes its own handoff, the prior
  session's handoff moves here via `git mv`.
- File names are date-stamped (`HANDOFF-YYYY-MM-DD[-suffix].md`).
- Dated TODOs (`TODO-YYYY-MM-DD.md`) follow the same archive convention.
- Engineering backlogs that span multiple sessions (`TODOS.md` at repo
  root, `docs/E2E_GAPS.md`, `docs/regression-coverage-backlog.md`) do
  NOT come here — they stay at their root locations as long as ≥1 item
  is open.

## What's here

| File | Session | One-line gist |
|---|---|---|
| `HANDOFF-2026-05-08.md` | 2026-05-08 evening | PR #644 merged + Google Doc audit on PRD gap items |
| `HANDOFF-2026-05-10.md` | 2026-05-10 | v3.6.0 release + Wave 8 phantom audit (4-agent dispatch on already-shipped scope) |
| `HANDOFF-2026-05-11.md` | 2026-05-11 evening | v3.7.2 + v3.7.3 releases — Sumit's 4 user-attention dispositions + phantom-cluster verification |
| `HANDOFF-2026-05-12-evening.md` | 2026-05-12 evening | Home→office handoff; pen-test wave triage + v3.7.4 + v3.7.5 audit-chain arc |
| `HANDOFF-2026-05-13-evening.md` | 2026-05-13 evening | All-issues sweep (60→4 open), 7 GH releases shipped today (v3.5.0 → v3.7.7), PR #710 merged |
| `TODO-2026-05-13.md` | 2026-05-13 office pickup | Three-things-to-do-first list for the next-session start |
| `ZYLU_PRD_ACCOMPLISHED.md` | 2026-05-11 | Wellness-vertical PRD-gap-doc audit (86 of 103 items already shipped — stale-doc finding) |

## Don't archive a file just because it's old

If the doc is still **load-bearing** for current work — i.e. someone
might pick it up tomorrow and act on it — it belongs at `docs/` root,
not here. The handoffs that landed here are session-specific snapshots
that have been **superseded by later sessions' work**. Their content
has either been folded into a permanent location (CHANGELOG, CLAUDE.md
standing rules, TODOS.md) or has aged past relevance.

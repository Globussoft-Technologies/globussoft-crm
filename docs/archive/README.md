# Documentation archive

This folder holds **point-in-time docs that are no longer live** — audits,
triage docs, closed-incident fix logs. Sibling archive folders are:

- [docs/handoffs-archive/](../handoffs-archive/) — date-stamped session handoffs + TODO snapshots
- [docs/gaps/archive/](../gaps/archive/) — fully-closed gap-tracking files (per CLAUDE.md convention)

## What's here

| File | Why archived |
|---|---|
| AUDIT_2026-05-17_code.md | Point-in-time code audit; superseded by later session work |
| AUDIT_2026-05-17_docs.md | Point-in-time docs audit; superseded by 2026-05-25 housecleaning |
| TRIAGE_ZYLU_GAP_2026-05-17.md | Triage doc for Zylu gaps; replaced by individual `docs/PRD_<gap>.md` files |
| NOTIFICATION_FIXES.md | Closed-incident fix log (#expense notifications, shipped v3.7.x) |

## Convention

- Move (don't delete) point-in-time docs once the work they document has
  shipped AND there's no live reference asking "what's the latest state?"
- Move via `git mv` so history is preserved.
- Update inbound references in the **live** docs (`docs/README.md`,
  `CLAUDE.md`, `TODOS.md`) when archiving — so live docs don't point to
  archived files.
- Internal cross-refs WITHIN archive files are allowed to rot; the archive
  isn't expected to be the primary read surface.

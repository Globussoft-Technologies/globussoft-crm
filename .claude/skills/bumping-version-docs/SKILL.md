---
name: bumping-version-docs
description: Updates the project's version-bumping doc set after a meaningful release-worthy session ends. Use when a parallel-agent wave (or a focused multi-day pickup) lands enough commits to warrant a version bump (typically every 6+ commits or 100+ new tests). Touches 5 files in lockstep — CHANGELOG.md (vX.Y.Z entry with the test-surface-delta table), README.md (version line + What's-new section), CLAUDE.md (version line + per-push test count), TODOS.md (handoff block refresh for the next session), docs/E2E_GAPS.md (mark items ✅ shipped + status block bump). Bundled templates capture the format every existing v3.4.x entry uses.
---

# Bumping version docs

## When to use

A wave of work just landed (4+ agents shipped, or one focused multi-day pickup). The collected commits warrant a version bump. Sessions today bumped 4 times: v3.4.0 → 3.4.1 → 3.4.2 → 3.4.3 → (next: 3.4.4 per the latest TODOS handoff).

NOT this skill:
- Single-commit fixes (those don't need a version bump; just push)
- Tagging the release itself (that's the `tagging-release` skill — separate concern)
- Initial setup of these doc files (out of scope; this skill assumes they exist with v3.4.x history)

## The 5-file dance

These edits go in ONE commit titled `docs: vX.Y.Z release notes — <subject>`.

| File | What to update |
|---|---|
| `CHANGELOG.md` | Add a new vX.Y.Z entry at the TOP, above the previous entry. Include the test-surface delta table + sections for Added / Fixed / etc. + Carry-over for vX.Y.Z+1. |
| `README.md` | Bump the **Version:** line in the header block. Add a "What's new in vX.Y.Z" section ABOVE the previous What's-new. Link back to the CHANGELOG entry. |
| `CLAUDE.md` | Bump the **Version:** line. Refresh the per-push test count line (`~X,XXX API tests + Y vitest = Z total per-push`). |
| `TODOS.md` | Replace the existing 🏁 handoff block at the top with a new block for the next session. Move the previous handoff's content into a brief "earlier session arc" footnote. Update the long-tail "still open" list. |
| `docs/E2E_GAPS.md` | Mark any G-x items that shipped this round as ✅. Update the "Status update" block at the bottom of the priority table. |

## Templates

See `CHANGELOG_ENTRY_TEMPLATE.md` for the canonical CHANGELOG entry shape; `TODO_HANDOFF_TEMPLATE.md` for the 🏁 block; `README_WHATSNEW_TEMPLATE.md` for the README section.

## Commit pattern

```
docs: vX.Y.Z release notes — <subject>

CHANGELOG.md: new vX.Y.Z entry covering N commits since vX.Y.(Z-1):
  - <bullet 1: gate specs added>
  - <bullet 2: contract drift fixes>
  - <bullet 3: spec cleanups / infra / docs>

README.md: vX.Y.(Z-1) -> vX.Y.Z + What's-new section + test-count refresh

CLAUDE.md: version-line refresh + per-push count refresh

TODOS.md: handoff block rewritten for vX.Y.Z state; long-tail list
refreshed; recommended next pickup is <X>

docs/E2E_GAPS.md: <G-IDs> marked shipped with commit hashes; status
block updated to reflect vX.Y.Z reality
```

## When to bump major vs minor vs patch

We've stayed in v3.4.x throughout this multi-session arc. Loose convention:

- **Patch (X.Y.Z+1)**: gate-spec growth, test infra, doc updates, contract-drift fixes that don't change product behavior. **Default for this project right now.** All v3.4.x bumps fit here.
- **Minor (X.Y+1.0)**: new product feature visible to customers (e.g. T2.1 mobile sidebar — it's a real UX change). Bump when ready.
- **Major (X+1.0.0)**: breaking schema change or API contract change. Save for genuine breaking work; we haven't needed one in this arc.

If unsure, default to patch. The CHANGELOG entry's contents communicate weight; the version number is just an ordering scheme.

## Stacked release entries before any tag push (added 2026-05-05)

Doc bumps and tag pushes are independent. The v3.4.10 → v3.4.11 arc landed two CHANGELOG entries (`dbe611a` for v3.4.10 + `1d07343` for v3.4.11) in succession **without any `git tag` push between them**. Pattern is supported: each release entry documents a coherent wave of work; tags can be pushed back-to-back when the operator is ready (each tag fires its own `e2e-full.yml` release-validation against demo).

Why this is fine:
- Tag pushes have visible side-effects (e2e-full runs against demo, ~15-20 min, hits the demo's accumulated state). Operators may want to batch them by daily / sprint cadence rather than firing twice per session.
- The CHANGELOG entries are immutable once published — stacking them doesn't break "the v3.4.10 entry should reflect v3.4.10 reality" since each entry's "Carry-over for vX.Y.Z+1" section names what it predicted, not what actually shipped (the next entry above shows what shipped).
- README's "What's new" section is also accumulating — keep the most recent ~3 entries' What's-new sections; older ones can be dropped.

What NOT to do:
- Don't merge two release entries' work into ONE CHANGELOG entry just because the tag hasn't been pushed yet. Each coherent wave deserves its own entry; the tags catch up later. If you're unsure whether two waves should be one entry, ask: "would a future engineer reading this entry want to find these two unrelated changes together?" — usually no.
- Don't backdate the second entry's date to match the first's. Each entry's date is when its docs landed (the commit's date).

## Gotchas

- **Commit titles include the version** — readers grep for `vX.Y.Z` in `git log` to find release commits.
- **Don't bump the version in `package.json`** in the same commit unless you're also tagging. The `git tag -a vX.Y.Z` step is the source of truth for the version label; package.json drifts and is fine.
- **The What's-new in README is a ~6-bullet summary**, NOT a copy of the CHANGELOG. Link to CHANGELOG for the full detail. README readers want fast orientation.
- **The CHANGELOG entry's test-surface-delta table is mandatory** — it's the at-a-glance health metric. Even a doc-only release entry should show "0 / 0 / 0" deltas so the reader can confirm.
- **The TODOS handoff block goes ABOVE all other content** so a fresh session sees it immediately on opening the file. The old handoff moves into a brief "Earlier session notes" line further down.

## Verification before commit

```bash
# 1. Check that the version is updated everywhere consistently
grep -rE "v3\.4\.[0-9]+" CHANGELOG.md README.md CLAUDE.md | head

# 2. Test count consistency — CLAUDE.md should match README.md should
# match the CHANGELOG entry's "now" column
grep -E "per-push|tests on every push|Total per-push" CHANGELOG.md README.md CLAUDE.md | head

# 3. The TODOS handoff block's HEAD reference should match git log -1
grep -E "HEAD on origin|HEAD: \`" TODOS.md | head -3
git log -1 --format='%h'
```

If any of these are inconsistent, fix before committing — drifted version refs are confusing for the next session.

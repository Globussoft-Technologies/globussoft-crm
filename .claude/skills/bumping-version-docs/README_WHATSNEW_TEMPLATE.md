# README.md "What's new" section — template

Insert ABOVE the previous What's-new section in `README.md`. Update the **Version:** line in the header block first.

```markdown
## What's new in vX.Y.Z (Mon DD YYYY — <one-line subject>)

<One short paragraph orienting the reader.>

- **<bold lead>**: <factual one-line: what shipped + impact metric>
- **<bold lead>**: <factual one-line>
- **<bold lead>**: <factual one-line>
- **<bold lead>**: <factual one-line>
- **<bold lead>**: <factual one-line>
- **<bold lead>**: <factual one-line>

See [CHANGELOG.md](CHANGELOG.md#vXYZ--YYYY-MM-DD--<slugified-subject>) for the full vX.Y.Z entry.
```

## Conventions

- **6 bullets max.** README readers want fast orientation; details go in CHANGELOG.
- Each bullet leads with a **bold subject** — makes scanning easy.
- Include a **metric where possible** ("**+90 tests**", "**~2,468 per-push**", "**10 issues closed**"). Numbers are scannable.
- Anchor link to CHANGELOG follows GitHub's auto-slug rule: lowercase, alphanumeric + dashes, dots stripped, em-dashes become double-dashes. Test the link before committing — broken anchors are silent failures.

## Anchor-link gotchas

GitHub slugifies CHANGELOG headings as:
- `## v3.4.3 — 2026-05-03 — eight-agent parallel wave` → `#v343--2026-05-03--eight-agent-parallel-wave`
- The `—` (em-dash) becomes `--` (double dash, not double hyphen)
- Dots are stripped (`v3.4.3` → `v343`)
- Spaces become single dashes (`eight agent` → `eight-agent`)

When in doubt, scroll to the heading on GitHub and copy the URL fragment.

## What NOT to put in What's-new

- Implementation detail. The bullet should be "what shipped + why it matters", not "how it was built".
- Commit hashes. Those clutter scanning. The CHANGELOG entry has them.
- Forward-looking statements. README is a snapshot; "we plan to..." goes in TODOS.
- Personal language. Stay factual.

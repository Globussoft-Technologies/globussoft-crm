> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-05 afternoon — v3.4.12 RELEASED + 27-issue closure wave fully shipped) — superseded above

**HEAD on origin/main:** `548da0f` (lint hotfix that unblocked the wave's deploy gate). All 6 deploy gates green; demo at HEAD with all 27 wave fixes live.

**v3.4.12 RELEASE STATUS: SHIPPED.** Tag `v3.4.12` at `f28fdcf` pushed; `e2e-full.yml` release-validation run `25375419864` went **all 4 shards + scrub-demo + merge-reports green** (first all-green since v3.4.9). The release stands. See [CHANGELOG.md](CHANGELOG.md#v3412--2026-05-05--pr-453-merged--5-agent-qa-wave-30-issues--e2e-full-all-green--g-21-frontend-vitest-gate--doc-canonicality-discipline) for full release notes.

### Post-release 27-issue closure wave (after v3.4.12 tag)

Dispatched 3 parallel-agent waves to close the QA backlog filed 2026-05-05 09:44–09:53 UTC + the Marketing/Channels feature-gap cluster filed shortly after.

| Wave | Agents | Commits | Issues closed |
|---|---|---|---|
| **W1** mobile-responsive | 4 | `66ff17d` `b8fc589` `b9927c3` `570ab2b` `f9892e4` `72a5d28` `0e89690` `f3b9227` `80ed287` `b642287` | #478 #479 #480 #481 #482 #483 #484 #485 #486 #488 #492 (11) |
| **W2** Marketing + Channels feature gaps | 2 | `557a79a` `9b58f87` | #487 #493 #494 #495 #496 #497 #498 #499 #500 #501 #502 #503 #504 (13) |
| **W3** color/brand polish | 1 | `4236980` `8d78bd9` `a6e8731` | #489 #490 #491 (3) |
| Lint hotfix | (parent) | `548da0f` | (no issue — unblocked deploy after Channels.jsx referenced an uninstalled `jsx-a11y/alt-text` rule via eslint-disable) |

**Total: 27 issues closed across 16 commits.** Open backlog back to **3 user-blocked** items (#431, #437, #457). Auto-close trailers fired on every commit; no manual issue-close pass required.

### Open backlog (still blocked on you)

- **B-01** TURNSTILE_SECRET_KEY env-var on demo (operator-blocker — Cloudflare Turnstile sitekey + secret pair)
- **#431** [P2][privacy] retention form silent-revert — awaiting fresh repro
- **#437** [P3][marketplace] /marketplace-leads visibility indicator — awaiting product-design call on UX
- **#457** Manual-only QA umbrella — intentionally stays open

### Follow-ups to file as fresh issues (surfaced by the wave's agents)

These are NOT blocking; file when bandwidth allows:

1. **`1fr 2fr` mobile-collapse bug also exists in Contracts/Estimates/Expenses/Projects** (W1-A finding) — same fix recipe as #478 + #480: replace inline `gridTemplateColumns: '1fr 2fr'` with a class wrapper + scoped `<style>` block carrying `@media (max-width: 768px) { .grid { grid-template-columns: 1fr !important; }}`. **Perfect 4-agent disjoint-files batch for the next wave.**
2. **`frontend/src/styles/responsive.css:151` Calendar selector is broken** — matches `[style*="minmax(180px"]` but actual Calendar grid uses `minmax(120px, 1fr)`, so the rule never fires. W1-A added `className="calendar-grid"` and `className="calendar-scroll"` to enable a future class-based migration. Sweep the file for similar attribute-selector brittleness.
3. **`POST /api/push/send-test`** — first-class endpoint inferring recipient from `req.user.userId`. W2-F's test-push UI currently reads `localStorage.user` as a workaround.
4. **`POST /api/sms/send-bulk`** — multi-recipient envelope a la #435 (top-level `email`/`messageId` for back-compat + `totalSent`/`totalFailed`/`results`/`failures` envelope). W2-F's Blast UI does N HTTP round-trips client-side; W2-E's Marketing SMS Blast composer would also benefit.
5. **`POST /api/whatsapp/send` Meta Cloud spec verification** — W2-F's UI assumed `{to, body, templateId}` mirrors SMS, but Meta requires `templateId` + variables array per their spec. May 400 on real WhatsApp send. One-line gate-spec check to confirm.
6. **`Channels.jsx` `useSearchParams()` deep-link consumption** — W2-E's Marketing CTAs now pass `/channels?tab=sms` and `/channels?tab=push`. Channels.jsx doesn't yet read those params to seed `activeTab`. ~2 lines of code.
7. **Off-brand color stragglers** under wellness theme (W3-H finding):
   - `Playbooks.jsx:254` `<FileText color="#8b5cf6" />` (purple decorative icon)
   - `Playbooks.jsx:358` `<Target color="#6366f1" />` (purple decorative icon)
   - `Reports.jsx:225` `<Filter color="var(--accent-color)" />` (renders salmon under wellness)
   - `Reports.jsx:343` Detail-type pill row uses `var(--accent-color)` for active state
   - `Reports.jsx:480` Edit-button text uses `var(--accent-color)`
8. **PR-level CI extension** — recommend adding `npx vite build` to PR-level CI (currently only `secret-scan` runs on PRs). PR #453 shipped with literal git conflict markers in two files because PR-level CI didn't catch them; the per-push gates only fired after merge. ~10-minute YAML edit.

### Process learnings to consider promoting into CLAUDE.md / skills

1. **Standing rule candidate (`--accent-color` vs `--primary-color`)**: "Primary CTAs and active-state surfaces should use `var(--primary-color, var(--accent-color))`. Use bare `var(--accent-color)` only for genuinely-secondary accents (decorative icons, low-priority text-only actions)." Reason: wellness theme defines `--accent-color` as the *secondary* blush `#CD9481` while `--primary-color` is the brand teal `#265855`. Using `--accent-color` for primary CTAs renders them salmon under wellness. Surfaced in W3-H + 6 stragglers above.
2. **Standing rule candidate (`min-width: 0` chain)**: For ellipsis to actually clip on flex/grid children, the chain needs `min-width: 0` at every nesting level (parent grid track via `minmax(0, ...)`, the cell, AND the inner inline-block holding the text). Without it, `text-overflow: ellipsis` silently degrades to "stretch parent". Surfaced in W1-A.
3. **Single-source responsive grid pattern (W1-B finding)**: `gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))'` + `gridColumn: '1 / -1'` for full-row spans. Works without media queries because `min(100%, 240px)` lets cells go below 240px on truly narrow viewports. Worth promoting to a shared utility in `frontend/src/styles/responsive.css`.
4. **Concurrency lesson for parallel-agent waves**: When sibling agents share a working tree, `git add <file> && git commit` can sweep up sibling-staged files via the index. Fix: use `git commit -o <file> -m "..."` (commits ONLY the named files even if other files are staged). W1-A discovered this by accident; W2-E + W2-F + W3-H used the pattern from the start with zero collisions. **Bake this into `AGENT_PROMPT_TEMPLATE.md`** under the Authority section.
5. **Lint-rule defensive policy**: Agents should NOT add `eslint-disable-next-line <rule>` directives without first verifying the rule is configured (`grep -r "<rule-name>" frontend/eslint.config.js`). The Channels.jsx W2-F push tripped the gate by referencing `jsx-a11y/alt-text` (plugin not in config). Single-line hotfix to drop the directive + use `alt=""` instead.

### Three things to do first next session (from office)

1. **File the 8 follow-up issues above** as fresh GitHub issues (or one umbrella issue per category) so they're tracked. Most have a clear fix recipe documented.
2. **Dispatch the next wave** if QA fresh bugs land overnight, OR pick up the `1fr 2fr` widespread fix (item 1 in follow-ups) — perfect 4-agent disjoint-files batch.
3. **B-01 TURNSTILE_SECRET_KEY** still pending — operator action needed.

### CI / deploy state at handoff

- **HEAD `548da0f`** — deploy gate all 6 jobs green + deploy job succeeded. Demo on HEAD.
- **Tag `v3.4.12`** — pushed; e2e-full release-validation green.
- **No outstanding red gates.** No outstanding rollbacks. Working tree clean.

---


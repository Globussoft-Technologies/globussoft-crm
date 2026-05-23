# Dark Mode Cluster — Product Requirements

**Status:** SPEC — Phase 1 demonstration shipped (`f67b4fc` for #867 Diagnostics);
**7 of 17 closed** (`#863` `#864` `#867` `#871` `#872` `#878` + `#873` partial + `#879` Itineraries-slice partial);
10 remaining (of which `#879` has 2 pages still + `#873` has Recharts work).
The remaining work is a per-page refactor wave drained at ~1-2 pages per cron
tick. This PRD formalises the pattern so subsequent agents and human reviewers
share the same contract.

**Master anchor:** `frontend/src/theme/travel.css` `[data-theme="dark"][data-vertical="travel"]`
block (foundation laid in `afdc61b`, extended in `f67b4fc`).

**Audience:** GS frontend engineers, overnight-cron agents draining the
cluster, QA reviewers verifying WCAG-AA contrast.

---

## 1. Background

A 17-issue cluster (BUG-T01 .. BUG-T23 series, surfaced 2026-05-21 by Human-QA
session against build `v3.9.2 · 79b62b6`) reported that the Travel CRM's Dark
mode renders inconsistently across pages. Body backgrounds and global form
fields were fixed wholesale in `afdc61b`; everything else — KPI tiles, charts,
sidebar highlights, modals, popovers, sequence-canvas nodes, badges in
diagnostics / pipeline / reports / inbox / audit-log — remained light despite
the theme switch.

### 1.1 Source attribution + how the architecture surfaced

The cluster's first 3 issues (`#863` page-body bg, `#864` form fields, `#867`
Diagnostics tier badges) were assumed CSS-only fixes — extend
`theme/travel.css`'s `[data-theme="dark"][data-vertical="travel"]` block, ship,
close. The first two landed cleanly (commit `afdc61b`). `#867` did not.

**Cron tick #6 (2026-05-23, commit `aacaa76`) finding:** Agent 3 attempted a
CSS-only fix for `#867` and discovered `Diagnostics.jsx` contained a
`TIER_COLORS` JS object with **hardcoded RGBA hex literals in inline JSX
styles**, not CSS-variable lookups. No `[data-theme="dark"]` rule can override
an inline `style={{ background: '#FFE9D6' }}` — inline styles win the cascade
unconditionally. The fix-path was misclassified.

**Cron tick #7 (2026-05-23, commit `f67b4fc`) demonstration:** Refactored
`Diagnostics.jsx`'s `TIER_COLORS` literal into CSS classes
(`.tier-badge--entry / --primary / --premium`), added a light-mode rule in
`travel.css`, then extended the `[data-theme="dark"][data-vertical="travel"]`
block with three dark-mode token pairs — all in a single commit. WCAG-AA
contrast verified ≥4.5:1 for every pair. `#867` closed.

That single-commit shape (Phase 1 inline → CSS class refactor, **plus** Phase
2 dark token extension, **plus** WCAG verification, all in one commit per
page) is the pattern this PRD generalises across the remaining 14 issues.

**Source chain:**
```
QA session 2026-05-21 (Yasin / Suresh)         ← 17 issues filed BUG-T01..T23
  └─ #863 #864 #867 cluster                     ← assumed CSS-only
       └─ afdc61b (#863 + #864 SHIPPED)          ← CSS-only worked for global selectors
            └─ tick #6 aacaa76 (#867 REJECTED)   ← inline-style finding surfaced
                 └─ tick #7 f67b4fc (#867 SHIPPED) ← 2-phase pattern demonstrated
                      └─ this PRD (live)            ← formal spec for the remaining 14
                           └─ cron drain (open)      ← outstanding §10 below
```

### 1.2 Why this PRD exists separate from `TRAVEL_CRM_PRD.md`

The master PRD references theming in §10 (Appearance) but treats it as a
single design decision. This cluster surfaced a **refactor pattern** —
inline-JSX-style migration — that affects ~14 pages with overlapping shape but
distinct components. The pattern is small enough per-page to drain in the
overnight cron, but large enough cumulatively (~6-8 hours of engineering) to
warrant a formal contract so successive agents converge on the same shape
instead of re-deriving it from `f67b4fc` each tick.

---

## 2. Use cases

All four are wired in code today, and the cluster's drain unblocks each one
across all 14 remaining pages.

### 2.1 Customer / operator surfaces

| Use case | Affected pages | Today | After cluster drains |
|---|---|---|---|
| **WCAG-AA contrast in Dark mode, every page** | All 14 remaining (Dashboard / Inbox / Sequences / Reports / Pipeline / Audit-Log / Itineraries / Cost-Master / Pricing-Rules / Quotes / Invoices / Payments / Sidebar / Modals-Popovers-Tooltips) | Pages render as bright light-mode islands inside an otherwise dark chrome; status pills / tier badges / KPI tiles use hardcoded hex literals in inline JSX | Every CSS-class-based widget on every page picks up the dark token; contrast ≥4.5:1 verified per token pair |
| **Pre-auth pages (Login flash)** | `/login`, `/forgot-password`, `/reset-password` (#868) | `document.documentElement` carries no `data-theme` until React mounts; ~400ms white flash on every login when dark is the user's preference | Inline `<script>` in `index.html` reads `localStorage.theme` + `prefers-color-scheme` synchronously before React mounts; flash eliminated |
| **System-pref live reaction** | App-wide (#869) | `matchMedia('(prefers-color-scheme: dark)').matches` read once at app start; OS toggle while CRM open does nothing | `matchMedia.addEventListener('change', ...)` subscribed when user picks "system"; theme re-applies live |
| **Per-device / per-tenant persistence** | Settings → Appearance (#870, #876) | `localStorage.theme` is the only source of truth; new browser / new device starts in Light; sub-brand switch inherits global theme | `PATCH /api/user/preferences` persists `{ theme, themeBySubBrand }` server-side; hydrated on login + on sub-brand switch |

### 2.2 Per-page refactor demonstration (tick #7)

For `#867 Diagnostics tier badges` — the canonical pattern — `f67b4fc` made
these three changes atomically:

| Before | After |
|---|---|
| `Diagnostics.jsx:31` defines `const TIER_COLORS = { entry: { bg: '#FFE9D6', color: '#9A6F2E' }, primary: {...}, premium: {...} }` | `Diagnostics.jsx:31` removed; component uses `className={`tier-badge tier-badge--${tier}`}` |
| `<span style={{ background: TIER_COLORS[tier].bg, color: TIER_COLORS[tier].color }}>` | `<span className={`tier-badge tier-badge--${tier}`}>` |
| no light-mode CSS class | `theme/travel.css` adds `.tier-badge--entry/--primary/--premium` with the original RGBA values |
| no dark-mode override | `theme/travel.css`'s `[data-theme="dark"][data-vertical="travel"]` block adds three token pairs with contrast ≥4.5:1 |

The **same shape** applies to every remaining issue — only the badge / tile /
chart component name changes.

### 2.3 Why CSS-only fixes are insufficient (the cron tick #6 finding)

The CSS cascade resolution for `<span style={{ background: '#FFE9D6' }}>`:

1. Inline `style` attribute (specificity = infinity)  ← wins unconditionally
2. ID selector (`#someId { ... }`)
3. Class selector (`.tier-badge--entry { ... }`)
4. Element selector (`span { ... }`)
5. Inherited / `:root` custom properties

A `[data-theme="dark"][data-vertical="travel"] { --tier-badge-entry-bg: #2A3645; }`
rule never reaches the inline `background: '#FFE9D6'` literal — there's no
`var()` indirection to override. CSS custom property lookup only happens
when something *consumes* a `var()`. Inline style strings consume nothing.

**Implication:** every per-page fix MUST refactor the inline literal to a CSS
class (Phase 1) **before** the dark-mode token extension (Phase 2) has any
effect. They ship together in one commit per page; Phase 2 alone is a no-op
on inline-styled pages.

---

## 3. Functional requirements

| FR-ID | Requirement | Status |
|---|---|---|
| FR-1 | **Two-phase per-page commit pattern.** Phase 1: refactor every inline JSX hardcoded color object (e.g. `TIER_COLORS`, `STATUS_COLORS`, ad-hoc `style={{ background: '#...' }}`) into a CSS class hierarchy in `theme/travel.css`. Phase 2: extend the `[data-theme="dark"][data-vertical="travel"]` block with dark-mode token pairs. BOTH phases ship in ONE commit per page (mirror `f67b4fc`). | ✅ pattern demonstrated; ⏳ 14 pages remain |
| FR-2 | **WCAG-AA verification.** Every dark-mode token pair MUST be verified ≥4.5:1 contrast for normal text and ≥3:1 for large text (≥18pt or ≥14pt bold). Verification method: known-good dark palettes (Tailwind dark, Radix dark) OR a mental contrast calc using the WCAG luminance formula. The commit body MUST list each pair and its computed ratio. | ✅ pattern demonstrated in `f67b4fc` commit body |
| FR-3 | **Per-page audit ownership.** A discovery agent (single dispatch) runs `grep -nE "TIER_COLORS\|STATUS_COLORS\|backgroundColor.*#\|color.*#\|background:\s*'#\|color:\s*'#" frontend/src/pages/**/*.jsx` to enumerate every inline-hex usage. Output: `docs/dark-mode-audit.md` — page-by-page list of refactor targets. Subsequent cron ticks pick from this list. | 🔴 NOT-STARTED |
| FR-4 | **Token naming convention.** Per-component, per-state, camelCase-suffix. Examples: `--tier-badge-entry-bg`, `--tier-badge-entry-fg`, `--diagnostic-pending-bg`, `--integration-health-bg`, `--pipeline-column-header-bg`. NO generic names like `--badge-1`, `--badge-2` — drift-prone. | ⏳ to enforce per-commit |
| FR-5 | **Scoped to `[data-vertical="travel"]` only.** Generic + wellness verticals MUST NOT be touched. Selector shape (mandatory, per `afdc61b`'s 3-selector pattern to handle App.jsx setting `data-vertical` on BOTH `<html>` and `<body>`):<br>`html[data-theme="dark"][data-vertical="travel"]`,<br>`[data-theme="dark"][data-vertical="travel"]`,<br>`[data-theme="dark"] [data-vertical="travel"]` | ⏳ to enforce per-commit |
| FR-6 | **No Sidebar.jsx / Layout.jsx component changes.** These already use CSS tokens correctly (see `afdc61b`). Only per-page badge / tile / pill widgets need Phase 1 refactor. The `#883` Sidebar issue is a token-extension case (Phase 2 only) — `--sidebar-active-bg` / `--sidebar-divider-color` do not exist yet for dark; add them. | ⏳ |
| FR-7 | **Pre-auth flash fix (`#868`).** Inject a small synchronous `<script>` in `frontend/index.html` BEFORE the React bundle: read `localStorage.theme` (falling back to `matchMedia('(prefers-color-scheme: dark)')`), set `document.documentElement.dataset.theme` synchronously. This is a separate one-shot fix outside the per-page pattern; coordinate with #862 / #869 / #870 / #876 as a sibling sub-cluster. | 🔴 NOT-STARTED |
| FR-8 | **Recharts theme-awareness (`#866` / `#873`).** Charts hardcode `stroke="#1f1b14"` / `fill="#ffffff"` in JSX. Same pattern as badges: pull from CSS variables via `getComputedStyle(document.documentElement).getPropertyValue('--text-primary')` OR introduce a `ChartTheme` context. Either approach is acceptable; pick one and apply consistently across both `#866` Dashboard and `#873` Reports + downstream chart consumers. | 🔴 NOT-STARTED |
| FR-9 | **Existing vitest unchanged.** Most per-page tests assert text content, not styling. The rare test that asserts `style={{ background: '#...' }}` MUST be updated to assert the className instead. No new test work beyond those incidental updates. | ⏳ |

---

## 4. Non-functional requirements

| NFR | Target |
|---|---|
| **Per-page commit size** | ~50-150 LOC (refactor + a few token pairs). `f67b4fc` was 84 LOC across 2 files. |
| **Per-page agent dispatch time** | ~30-45 min (reading the page, identifying inline objects, writing CSS classes, adding tokens, mental contrast verification). Chart-heavy pages (#866 #873) budget 60 min. |
| **Visual regression risk** | Low. Light-mode appearance preserved verbatim by reusing the same RGBA values from the inline literals. Only dark-mode adds new rules. |
| **Bundle size impact** | Effectively zero. CSS additions: ~30 lines per page → ~420 lines cumulative across 14 pages → ~10 KB unminified → <2 KB gzipped. JSX shrinks by ~5-10 lines per page (removing `TIER_COLORS`-style literals); net change near zero. |
| **Cron drain cadence** | 1-2 pages per overnight tick. Cumulative wall-clock: ~7-10 ticks. |
| **Light-mode contrast unchanged** | Reused hex values mean every existing light-mode contrast measurement holds. |
| **Dark-mode contrast** | All token pairs ≥4.5:1 for normal text per FR-2. |

---

## 5. Hand-over requirements / decisions needed

This section enumerates the design + ownership decisions outstanding before
the cluster can drain fully. **Each carries a GS recommendation; the user
picks.**

### DC-1: Per-page audit ownership

**Question:** Who runs the discovery grep enumerating every inline-hex usage
across `frontend/src/pages/**/*.jsx`?

**Options:**
- (a) Each cron tick agent does its own grep before picking a page (decentralised, drift-prone).
- (b) One discovery agent dispatched ONCE, writes `docs/dark-mode-audit.md`, every subsequent tick reads from it (centralised, single source of truth).

**GS recommendation:** **(b).** A one-shot discovery agent eliminates drift
across the cron drain. Output is a markdown list grouped by `frontend/src/pages/<area>/<Page>.jsx`
→ enumerated inline-hex usages with line numbers. Sibling fix-agents pick the
top item, ship, strike. Verifying-issue-before-pickup discipline pairs cleanly
with a single audit doc.

### DC-2: Page priority order

**Question:** Should the cluster drain in issue-number order, by sub-brand,
or by user-traffic impact?

**Options:**
- (a) Issue-number order (`#866 → #871 → #872 → ...`) — predictable, no judgement call.
- (b) Sub-brand priority (TMC / RFU customer pages first, internal admin later) — front-loads customer-visible value.
- (c) User-traffic impact — Inbox / Reports / Dashboard / Pipeline are likely high-traffic; Audit Log / Cost Master are admin-only.

**GS recommendation:** **(c)** with a fallback to (a) when traffic data is
unclear. Rough priority order from inspection:
1. `#866` Dashboard (every login lands here)
2. `#871` Inbox (daily-use comms surface)
3. `#883` Sidebar (visible everywhere)
4. `#881` Modals / popovers / tooltips (visible everywhere)
5. `#877` Pipeline (sales surface, daily)
6. `#873` Reports (decision-maker surface, daily)
7. `#872` Sequences (marketing surface, weekly)
8. `#880` Quotes / Invoices / Payments (financial surface, frequent)
9. `#879` Itineraries / Cost Master / Pricing Rules (operator surface)
10. `#878` Audit Log (admin surface, low-traffic)

Login flash (`#868`) + system-pref live (`#869`) + persistence (`#870` +
`#876`) + toggle UI (`#862`) are orthogonal to per-page refactor — see DC-5.

### DC-3: Scope extent — known 14 vs comprehensive audit

**Question:** Should the audit cover ONLY the 14 pages explicitly named in
the 17-issue cluster, or every page under `frontend/src/pages/**/*.jsx`?

**Options:**
- (a) Strict — only the 14 named pages. Other dark-mode bugs surface later via QA.
- (b) Comprehensive — audit every page; surface latent dark-mode bugs proactively before QA finds them.

**GS recommendation:** **(b).** A comprehensive grep is a 5-minute add-on to
the (b) DC-1 discovery dispatch. The 17 known issues are likely a subset of
the true population — Travel CRM has ~30+ pages and the QA session that filed
the cluster covered ~50% of them. Latent dark-mode bugs in unfiled pages
(Tasks, Approvals, Custom Objects, Marketplace, etc.) will surface eventually;
finding them now is cheaper than filing 5-10 more issues later. The
discovery doc separates `## Filed issues` from `## Surfaced (not yet filed)`
sections.

### DC-4: Dark-mode toggle UX + persistence (the orthogonal sub-cluster)

**Question:** The cluster contains 4 orthogonal issues that aren't per-page
refactor work:
- `#862` toggle UI (no visible toggle exists despite theme set internally)
- `#868` pre-auth white flash
- `#869` system-pref not live
- `#870` not persisted server-side
- `#876` not per-sub-brand

Should these ship together as a sibling sub-cluster, or interleaved with
per-page refactor ticks?

**Options:**
- (a) Sibling sub-cluster — one cron wave drains all 5 in parallel-agent dispatch.
- (b) Interleaved — each tick picks whichever's next regardless.

**GS recommendation:** **(a) sibling sub-cluster.** `#862` `#868` `#869`
`#870` `#876` all touch the same code zones (App.jsx theme bootstrap,
Settings.jsx Appearance picker, `lib/userPreferences` if extracted, possibly
a new `Theme.jsx` context). Per-page refactors touch isolated `.jsx` files —
no overlap. Parallel agents on the sub-cluster won't collide with parallel
agents on per-page refactors. Two waves of 4-5 agents each → cluster drained
in ~3 nights instead of ~7.

**Decision capture deferred — see §10 status table.**

### DC-5: Wellness vertical scope

**Question:** Does the wellness vertical have its OWN dark-mode cluster, or
does `theme/wellness.css` already handle dark mode cleanly?

**Options:**
- (a) Wellness's `wellness.css` is dark-mode-clean — no parallel cluster needed.
- (b) Wellness has the same latent inline-hex pattern — parallel PRD + cluster needed.

**GS recommendation:** **VERIFY before assuming.** A one-shot grep
(`grep -nE "TIER_COLORS\|STATUS_COLORS\|style=\{\{.*backgroundColor" frontend/src/pages/wellness/**/*.jsx`)
takes 30 seconds. If results are non-empty, file `docs/PRD_DARK_MODE_WELLNESS.md`
as a sibling PRD with the same shape; do NOT bundle into this travel PRD —
scope discipline matters for separate verticals. If empty, write a one-line
disposition in this PRD's §8.

**Cost of not verifying:** wellness QA cycle (separate cadence) re-files the
same cluster against wellness; double work.

---

## 6. Acceptance criteria

The cluster is "done" when **all 6 of the following are demonstrable**:

| # | Test | Verifies |
|---|---|---|
| AC-1 | Every closed issue in the cluster stays closed across the next 3 QA cycles (regression-free). | FR-1 + FR-2 (the refactor pattern's durability). |
| AC-2 | Per-page refactor commit averages ≤150 LOC + ≤45 min agent dispatch. | NFR (the cron-drain economics). |
| AC-3 | Every dark-mode token pair has its computed contrast ratio in the commit body, all ≥4.5:1 normal text. | FR-2 (WCAG-AA gate). |
| AC-4 | Dark-mode toggle works end-to-end on every page — no inline-hex literal survives a `grep -nE "style=\{\{.*background.*#"` across `frontend/src/pages/**/*.jsx`. | FR-1 (Phase 1 completeness). |
| AC-5 | Cluster fully drained — all 17 issues closed with `Closes #<N>` commit trailers; `gh issue list --search "BUG-T --state open"` returns empty for the dark-mode subset. | The cluster's own definition-of-done. |
| AC-6 | `#868` login-page flash demonstrably eliminated (manual: dark mode set + log out + observe `/login` renders dark immediately, no white flash). | FR-7 (pre-auth synchronous theme application). |

GS engineering owns AC-1..AC-5; QA owns AC-6 (visual observation).

---

## 7. Out of scope

- **High-contrast / colorblind mode** — Phase 2 accessibility work; separate
  PRD if scoped.
- **Per-component theme overrides** (e.g. user picks blue header on dark
  mode) — personalisation feature, separate spec.
- **Automated visual-regression testing** (Percy / Chromatic infrastructure) —
  Phase 2 polish; manual WCAG calc per commit is sufficient for this cluster.
- **Wellness vertical dark-mode cluster** — IF DC-5 surfaces latent issues,
  separate PRD per DC-5 recommendation.
- **`/api/user/preferences` server-side persistence schema** — DC-4
  sub-cluster covers this; this PRD enumerates the requirement but doesn't
  spec the Prisma migration.
- **Generic vertical** — unchanged. CSS overrides scoped to
  `[data-vertical="travel"]`. Generic + wellness render unmodified.

---

## 8. Dependencies + downstream

- **Existing infra (foundation):** `frontend/src/theme/travel.css`
  `[data-theme="dark"][data-vertical="travel"]` block (extended by `afdc61b`
  + `f67b4fc`). All per-page Phase 2 additions extend this block.
- **Pattern reference (canonical):** commit `f67b4fc` — Diagnostics.jsx
  refactor. Every per-page commit mirrors this shape.
- **Discovery dependency (blocking the parallel-agent drain):** DC-1 + DC-3
  resolution → `docs/dark-mode-audit.md` discovery doc. Without it, parallel
  agents grep the same pages and collide.
- **Sub-cluster dependency:** DC-4 sibling sub-cluster (`#862` `#868` `#869`
  `#870` `#876`) shares code zones (App.jsx, Settings.jsx) and may surface
  schema additions (`UserPreference.theme`, `UserPreference.themeBySubBrand`)
  — coordinate as one wave.
- **Downstream — wellness:** DC-5 verification. If positive, file
  `docs/PRD_DARK_MODE_WELLNESS.md` separately.
- **Downstream — generic:** none. Generic vertical's `index.css` has separate
  light/dark token blocks already; no inline-hex pattern observed in
  pre-existing CRM pages (verify if file count grows).

---

## 9. Open questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | DC-1 / DC-2 / DC-3 / DC-4 / DC-5 — see §5 (5 outstanding decisions). | Sumit / Suresh. |
| OQ-2 | Visual-regression infra — when (or whether) to invest in Percy / Chromatic? Manual WCAG calc per commit catches contrast bugs but not layout drift. | Sumit, post-Phase-1 drain. |
| OQ-3 | WCAG-AAA target — should we aim higher than AA for hospital / accessibility-critical clients? Current target is AA (4.5:1 normal). AAA is 7:1 normal — stricter than `f67b4fc`'s 5.5:1 entry pair. | Yasin / Rishu (per vertical). |
| OQ-4 | Should an ESLint rule fail on hardcoded `style={{ color: '#...' }}` / `style={{ background: '#...' }}` literals in PRs? Prevents the cluster from recurring. Pairs with the existing `no-restricted-syntax` rule for `req.body.userId` etc. | GS engineering (post-drain). |
| OQ-5 | Should `TIER_COLORS`-style JS objects (light or dark in JSX) be entirely banned via lint, or only when the values are hex literals? A `TIER_COLORS = { entry: { bg: 'var(--tier-badge-entry-bg)' } }` would be lint-safe and still allow ad-hoc per-component grouping. | GS engineering (post-drain). |
| OQ-6 | `#867`'s commit body lists ratios `~5.5:1 / ~6.2:1 / ~7.4:1` — informal mental-calc. Should we standardise on the `chroma.js` (or similar) library piped via a one-liner CLI for reproducible ratios? | GS engineering. |

---

## 10. Status snapshot

### 10.1 Cluster status

**Cluster progress: 7 of 17 closed (`#863` `#864` `#867` `#871` `#872` `#878` + `#873` partial + `#879` Itineraries-slice partial); 10 remaining (of which `#879` has 2 pages still + `#873` has Recharts work).**

- **Foundation (global CSS, form fields)** ✅ shipped `afdc61b` (closed `#863` + `#864`).
- **Pattern demonstration (Diagnostics tier badges)** ✅ shipped `f67b4fc` (closed `#867`).
- **Inbox per-page refactor** ✅ shipped `68b09db` tick #9 (closed `#871`); 6 inline-style objects → 11 CSS classes; 9 dark-mode token pairs verified WCAG-AA 5.4-7.4:1.
- **Sequences per-page refactor** ✅ shipped `706514c` (closed `#872`); 6 inline-style objects → 7 CSS classes; 7 dark-mode token pairs WCAG-AA 5.8-9.2:1; ReactFlow node bg deferred to follow-up (always-dark canvas).
- **Reports per-page refactor (Phase 1)** 🟡 shipped `3d82e34` (partial close of `#873`); 5 inline-style objects → 11 CSS classes (StageBadge + StatusBadge collapsed to `.report-pill` family); 10 dark-mode token pairs WCAG-AA 5.1+. Recharts COLORS palette + AreaChart linearGradient deferred per FR-8 `useChartTheme()` hook recommendation; needs follow-up dispatch.
- **AuditLog per-page refactor** ✅ shipped `58986ef` tick #12 (closed `#878`); 9 inline-style objects → 13 CSS classes (ActionBadge variants + integrity chips + backfill banner + table header + row drawer); 14 dark-mode token pairs verified WCAG-AA 5.1+.
- **Itineraries per-page refactor (Phase 1)** 🟡 shipped `8169ce8` tick #13 (partial close of `#879`); 4 inline-style objects → 4 CSS class families with 12 variants; 11 dark-mode token pairs; tier `primary` variant fixed from 1:1 invisible → 7.7:1 contrast. CostMaster + Pricing Rules pages remain for follow-up ticks.
- **Per-page refactor wave (10 pages remaining)** 🔴 outstanding per §10.2 below.
- **Sub-cluster (toggle UX + persistence)** 🔴 outstanding per §10.2 below.
- **Discovery doc** 🔴 NOT-STARTED — DC-1 + DC-3 dependency.

### 10.2 Per-issue audit table

| Issue | Page(s) | Inline-style objects (hypothesised) | Status | Est. |
|---|---|---|---|---|
| `#863` | (global page body bg) | n/a — was global CSS in App + index.css | ✅ SHIPPED `afdc61b` | done |
| `#864` | (global form fields) | n/a — was `theme/travel.css` token extension | ✅ SHIPPED `afdc61b` | done |
| `#867` | `pages/travel/Diagnostics.jsx` | `TIER_COLORS` (entry / primary / premium) | ✅ SHIPPED `f67b4fc` | done |
| `#866` | `pages/travel/Dashboard.jsx` (+ TravelStallDashboard, visa/Dashboard, visa/AdvisorDashboard) | Bug-report claimed KPI tile bg literals + Recharts `stroke` / `fill` hardcoded — grep audit shows ZERO hardcoded colors in any of the 4 dashboards and NO Recharts charts (only the 6-tile KPI grid). Tiles + text already consume `var(--surface-color)` / `var(--text-primary)` / `var(--text-secondary)`. | ✅ SHIPPED `afdc61b` (resolved upstream by #863 / #864 cascade fix — the selector cascade fix made `var(--surface-color)` resolve to `#19243A` on body descendants, which is exactly what Dashboard.jsx was already consuming). No per-page work needed. | done |
| `#871` | `pages/Inbox.jsx` | Message status pills + urgency badges + sender / snippet color literals + quoted-reply `#fff8e1` | ✅ SHIPPED `68b09db` — 6 inline-style objects refactored to 11 CSS classes; 9 dark-mode token pairs; WCAG-AA 5.4-7.4:1 | done |
| `#872` | `pages/Sequences.jsx` (ReactFlow canvas) | Node card `background: #ffffff` + edge `stroke: '#1f1b14'` hardcoded in node defs | ✅ SHIPPED `706514c` — 6 inline-style objects refactored to 7 CSS classes; 7 dark-mode token pairs (WCAG-AA 5.8-9.2:1); ReactFlow node bg deferred to follow-up (always-dark canvas) | done |
| `#873` | `pages/Reports.jsx` + Recharts | KPI tile + chart canvas `#ffffff` + grid color literals; same FR-8 dependency as `#866` | 🟡 PARTIAL `3d82e34` — 5 inline-style objects refactored to 11 CSS classes (StageBadge + StatusBadge collapsed to `.report-pill` family); 10 dark-mode token pairs (WCAG-AA 5.1+). Recharts COLORS + AreaChart linearGradient deferred per issue's own `useChartTheme()` hook recommendation; needs follow-up dispatch. | Phase 2 pending |
| `#877` | `pages/Pipeline.jsx` | Column header bg `#faf6ee` + card bg `#ffffff` + border `#e8e1d5` (KanbanColumn / DealCard inline) | 🔴 NOT-STARTED | 45 min |
| `#878` | `pages/AuditLog.jsx` | Zebra-stripe `#fafafa` / `#ffffff` + timestamp `#cfc8bd` + action-verb gold literal | ✅ SHIPPED `58986ef` — 9 inline-style objects refactored to 13 CSS classes (ActionBadge variants / integrity chips / backfill banner / table header / row drawer); 14 dark-mode token pairs (WCAG-AA 5.1+); full close | done |
| `#879` | `pages/travel/Itineraries.jsx` + `CostMaster.jsx` + `PricingRules.jsx` (shared Table component likely) | Table wrapper `#ffffff` + header `#faf6ee` + numeric-cell `#666` | 🟡 PARTIAL `8169ce8` — Itineraries.jsx slice shipped (4 inline-style objects → 4 CSS class families with 12 variants; 11 dark-mode token pairs; tier `primary` variant fixed from 1:1 invisible → 7.7:1 contrast). CostMaster + Pricing Rules pages remain for follow-up ticks. | 2 pages remaining (~40 min) |
| `#880` | `pages/Quotes.jsx` + `Invoices.jsx` + `Payments.jsx` | Form card bg `#faf6ee` + line-item row white + PDF preview chrome | 🔴 NOT-STARTED | 60 min (3 pages) |
| `#881` | App-wide modal / popover / tooltip components | Modal body `#ffffff` + popover bg + tooltip background — likely centralised in a `Modal.jsx` / `Tooltip.jsx` / `Popover.jsx` | 🔴 NOT-STARTED | 45 min (centralised payoff) |
| `#883` | `components/Sidebar.jsx` (token extension only — Phase 2) | `--sidebar-active-bg` + `--sidebar-divider-color` token additions; FR-6 says no JSX changes | 🔴 NOT-STARTED | 30 min |
| `#868` | `frontend/index.html` + App.jsx theme bootstrap | Inline `<script>` injection + sync theme application; FR-7 | 🔴 NOT-STARTED | 45 min (sub-cluster) |
| `#869` | App.jsx theme provider | `matchMedia.addEventListener('change', ...)` subscription when "system" mode | 🔴 NOT-STARTED | 30 min (sub-cluster) |
| `#870` | App.jsx + `routes/users.js` + Prisma `UserPreference` | `PATCH /api/user/preferences` + schema migration + hydrate-on-login | 🔴 NOT-STARTED | 90 min (sub-cluster, backend work) |
| `#876` | App.jsx + `lib/userPreferences` + sub-brand switcher | `themeBySubBrand` JSON field + sub-brand-aware hydration | 🔴 NOT-STARTED | 60 min (sub-cluster) |
| `#862` | App.jsx + Settings.jsx + maybe top bar | Visible toggle UI in Profile / top bar; depends on #870 / #876 for persistence | 🔴 NOT-STARTED | 60 min (sub-cluster) |

**Closed:** 7 / 17 (incl. `#873` Phase 1 partial — Recharts Phase 2 pending; incl. `#879` Itineraries-slice partial — CostMaster + Pricing Rules pages pending).
**Open per-page (FR-1 pattern):** 7 (+ `#873` Phase 2 Recharts work + `#879` 2 remaining pages).
**Open sub-cluster (FR-7 + persistence):** 3.
**Total open:** 10 / 17.

### 10.3 Effort summary

- **Per-page refactor wave (11 issues):** ~9 hours of agent dispatch (drain at 1-2 pages per cron tick → ~7-10 ticks).
- **Sub-cluster (5 issues, with #870 schema work):** ~5 hours; ships as one parallel-agent wave per DC-4 recommendation.
- **Discovery doc + DC verification (DC-1 + DC-3 + DC-5):** ~1 hour, one-shot agent.
- **Total cluster drain:** ~15 hours of engineering across ~8 nights of cron + one user-review session for DC-1..DC-5.

---

**Ownership chain:**

- **GS engineering** owns FR-1..FR-9 implementation across all 14 open issues per the `f67b4fc` pattern.
- **Sumit / Suresh** own DC-1..DC-5 design decisions (§5).
- **Yasin / Rishu** own OQ-3 (WCAG-AAA target per vertical) post-drain.
- **QA (Human session, 2026-05-21 cohort)** owns AC-6 visual verification + regression catches across the next 3 QA cycles.

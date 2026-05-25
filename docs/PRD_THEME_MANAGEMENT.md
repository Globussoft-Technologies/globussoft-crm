# Theme Management — Product Requirements

**Status:** SPEC — coordinating PRD written 2026-05-23 (cron tick #26). Sibling
to `PRD_DARK_MODE_CLUSTER.md` (per-page CSS surface work) and
`PRD_TRAVEL_PER_SUBBRAND_BRANDING.md` (brand-kit + palette source-of-truth).

**Coordinates 3 OPEN GH issues:**
- `#862` — No in-app theme toggle UI (light/dark switching not proper)
- `#870` — Theme not persisted server-side; does not roam across devices/sessions (BUG-T04)
- `#876` — Theme should be per-sub_brand (TMC / RFU / Travel Stall / Visa Sure) (BUG-T06)

**Audience:** GS frontend + backend engineers implementing the toggle UI +
preference roaming + per-sub-brand resolution; QA verifying the persistence +
roaming + fallback chain; PM / Yasin for design-decision sign-off.

---

## 1. Background

The CRM has a working theme model — `App.jsx` applies `data-theme` via React
useEffect, listens to `prefers-color-scheme` for the `system` mode, and reads
from `localStorage.theme` at boot. `index.html` was extended in tick #19
(`f9bd2c3`) to inline-seed `data-theme` before React mounts (preventing FOUC,
closing `#868`). `Settings.jsx` exposes a three-option picker
(`light / dark / system`) under Appearance.

What the model does **not** do:
- Surface a one-click toggle from the top navigation (only reachable via /settings)
- Persist preference to the server (loses on device-switch, clearing site-data, second browser)
- Distinguish theme by active sub-brand context (TMC / RFU / Travel Stall / Visa Sure all share one global preference)

This PRD coordinates the three gaps as a single design surface because they
share state (the user's theme preference) and a single resolution chain
(per-sub-brand → user → tenant → system → light).

### 1.1 Source attribution

- `#862` filed via Travel Stall CRM QA audit 2026-05-21 (Human-QA session against `v3.9.2 · 79b62b6`)
- `#870` (BUG-T04) same audit — server-side persistence gap
- `#876` (BUG-T06) same audit — per-sub-brand UX gap
- Per-page CSS work (the *surfaces* the theme paints) lives in `PRD_DARK_MODE_CLUSTER.md` — that PRD is about WHAT the theme paints; this PRD is about HOW the operator selects it and HOW the system remembers it

### 1.2 Existing infrastructure (do NOT rebuild)

| Surface | Where it lives | What it does |
|---|---|---|
| Theme useEffect | `frontend/src/App.jsx:458-486` | Computes effective theme (light/dark) + applies `data-theme` attribute |
| matchMedia listener | `frontend/src/App.jsx:470-479` | Auto-flips dark↔light when system preference changes (mode=`system` only) |
| Inline FOUC seed | `frontend/index.html` (script before React mounts, tick #19 `f9bd2c3`) | Reads `localStorage.theme` and sets `data-theme` synchronously |
| Appearance picker UI | `frontend/src/pages/Settings.jsx:~371` | Three radio options: light / dark / system |
| Client-side persistence | `localStorage.theme` | Browser-local; no roaming |
| Per-vertical theme overlay | `frontend/src/theme/travel.css`, `wellness.css` | CSS for `[data-theme="dark"][data-vertical="X"]` selector chains |
| Sub-brand context | `Sidebar.jsx` (per tick #16 dual-section nav) + `Tenant.subBrandConfigJson` (`621aab7`) | Stores per-sub-brand config; theme prefs slot in here |

**The work in this PRD is additive on top of all of the above** — none of
these surfaces gets ripped out.

---

## 2. Use Cases

| # | Persona | Story |
|---|---|---|
| UC-2.1 | Travel CRM operator | Click theme toggle in top nav → UI flips light↔dark immediately, persists across page navigation, no /settings detour (#862) |
| UC-2.2 | Multi-device operator (Yasin) | Set Dark on desktop → log in on phone → phone is also Dark (#870) |
| UC-2.3 | Multi-sub-brand operator | Set TMC light + Visa Sure dark → switching the active sub-brand context flips the theme automatically (#876) |
| UC-2.4 | Tenant admin | Set default theme for each sub-brand (operators inherit unless they personally override) |
| UC-2.5 | Customer-portal visitor | Land on `/portal/<sub-brand>/*` → portal renders in that sub-brand's default theme (not the visitor's CRM preference) |
| UC-2.6 | New tenant onboarding | Pick a tenant-default theme during onboarding → all new users in that tenant default to it |
| UC-2.7 | Returning user, fresh browser | Log in on a never-used browser → server-stored preference applies before any flash |

---

## 3. Functional Requirements

### FR-3.1 In-app theme toggle (#862)

- **(a)** Theme toggle button rendered in the top navigation (icon: Sun / Moon / Auto). Visible on every authenticated route.
- **(b)** Click cycles `light → dark → system → light`. Tooltip names the next state.
- **(c)** Optional: keyboard shortcut (`Cmd/Ctrl + Shift + T`). If implemented, advertise in the tooltip.
- **(d)** Visual transition is a smooth color crossfade (≤300ms), not a hard flip. CSS `transition` on `background-color, color, border-color`.
- **(e)** Persistent across page navigation (already works via `localStorage`; preserve when adding server-side write).
- **(f)** The Settings.jsx Appearance picker continues to work in parallel — the toggle and the picker are two surfaces over the same state.

### FR-3.2 Server-side persistence (#870)

- **(a)** Add `User.themePreference` enum (`light` | `dark` | `system` | `per-sub-brand`). Nullable; default `null` (falls through to tenant default).
- **(b)** Add `Tenant.defaultThemePreference` enum (same options, minus `per-sub-brand`). Nullable; default `null` (falls through to `system`).
- **(c)** On theme change, fire `PATCH /api/users/me/preferences { theme: <value> }`. Non-blocking — UI flips immediately on the client, the server-write is fire-and-forget with retry-on-failure.
- **(d)** On login, the auth response includes `preferences.theme` (and `preferences.subBrandThemeOverrides` if FR-3.3 ships). Client applies before first paint.
- **(e)** Fallback chain (highest → lowest): per-sub-brand override → user preference → tenant default → system → light.
- **(f)** Backwards-compat: existing `localStorage.theme` value continues to apply; the first authenticated request after rollout syncs it to the server. No prompt, no data-loss.
- **(g)** `/api/users/me/preferences` endpoint returns the resolved chain in its response (so the client can show "you're seeing the tenant default" vs "your personal pref").

### FR-3.3 Per-sub-brand theme (#876)

- **(a)** Add `User.subBrandThemeOverrides` JSON column: `{ [subBrandId]: 'light' | 'dark' | 'system' }`. Nullable.
- **(b)** Theme applied is computed from the **currently-active sub-brand context** (read from the sidebar selector or URL `?subBrand=`).
- **(c)** Admin UI: per-sub-brand default theme picker lives in `/settings/brand-kits` (extending the existing brand-kit editor, owned by `PRD_TRAVEL_PER_SUBBRAND_BRANDING.md`).
- **(d)** Customer-portal routes `/portal/*` and `/p/<slug>` use the **sub-brand default**, not the visitor's CRM theme preference. (Customer-side preference is out of scope — see §7.)
- **(e)** Fallback chain (highest → lowest): per-sub-brand override → user preference → sub-brand default → tenant default → system → light.
- **(f)** "Apply to all sub-brands" affordance in the Appearance picker — one-click bulk-set for operators who want consistency across all 4 sub-brands.

### FR-3.4 Migration + rollout

- **(a)** Existing `localStorage.theme` values migrate to `User.themePreference` on the first authenticated request after rollout. Silent — no operator action required.
- **(b)** Per-tenant feature flag (`Tenant.featureFlags.themeManagementV2`) — rollout gradually, starting with Travel Stall (the QA-source tenant).
- **(c)** Telemetry: log each preference change to `AuditLog` (existing audit infra) with `action='theme.change'` and `meta={ from, to, subBrandId? }` for adoption tracking.
- **(d)** Document migration steps + roll-forward / rollback in PRD §8 (Dependencies).

---

## 4. Non-functional Requirements

| ID | Requirement |
|---|---|
| NFR-4.1 | Theme switch transition completes ≤300ms (no jarring flash, no FOUC on toggle click) |
| NFR-4.2 | localStorage → server sync is non-blocking — must NOT delay login by more than 50ms in p95 |
| NFR-4.3 | Theme preference fetch is batched with other user prefs into a single round-trip on login (no separate `/api/users/me/preferences` call) |
| NFR-4.4 | Per-sub-brand theme switch on context-flip ≤500ms (perceived as instant) |
| NFR-4.5 | Toggle button + picker are keyboard-accessible (tab-reachable, Enter/Space activates) and screen-reader-labeled |
| NFR-4.6 | Migration of existing `localStorage.theme` values: 100% silent, zero operator interaction, zero data loss |

---

## 5. Design Decisions Required

| ID | Decision | Owner |
|---|---|---|
| DD-5.1 | Toggle placement — top nav (visible everywhere) vs sidebar (with other settings) vs both? | PM / Yasin |
| DD-5.2 | When user preference and tenant default conflict on first login (user has localStorage `dark`, tenant default is `light`), which wins? Recommend: user wins; the localStorage migration is treated as an explicit choice. | PM |
| DD-5.3 | Per-sub-brand theme: opt-in (user must enable in settings) or auto-applied (any per-sub-brand override is honored)? Recommend: auto-applied — the affordance to set per-sub-brand is the explicit opt-in. | PM |
| DD-5.4 | System preference responsiveness in `system` mode — live (matchMedia listener fires immediately on OS-level change) or on-next-load (apply once at boot)? Current code is live (line 470-479). Confirm we keep live. | Engineering |
| DD-5.5 | Customer portal theme — always sub-brand default OR honor visitor's portal-level preference (if any)? Recommend: always sub-brand default; visitor-side personalization is out of scope. | PM |
| DD-5.6 | Migration of existing `localStorage.theme` values — silent or one-time prompt ("we now remember your theme across devices — keep your current pick?")? Recommend: silent (UX heuristic; the prompt is noise). | PM |

---

## 6. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-6.1 | Click theme toggle in top nav → theme flips within 300ms; persists across SPA navigation and full page reload |
| AC-6.2 | Set Dark on browser A → log in on browser B as same user → browser B is Dark before first paint (no FOUC) |
| AC-6.3 | Set TMC = light + Visa Sure = dark → switch sub-brand context from TMC to Visa Sure → UI flips to dark within 500ms |
| AC-6.4 | New user signs up under tenant whose default is Dark → first login renders Dark |
| AC-6.5 | Existing user with `localStorage.theme = 'dark'` logs in for first time after rollout → server-side `User.themePreference` is now `'dark'`; no operator-visible change |
| AC-6.6 | Customer-portal visitor lands on `/portal/<tmc-slug>/*` → portal renders in TMC's default theme regardless of any other context |
| AC-6.7 | Keyboard shortcut `Cmd/Ctrl + Shift + T` cycles light → dark → system → light |
| AC-6.8 | Tenant admin sets per-tenant default theme in /settings → new users in that tenant default to it; existing users with explicit preferences are unaffected |
| AC-6.9 | "Apply to all sub-brands" button in Appearance picker copies current value into every entry of `subBrandThemeOverrides` |
| AC-6.10 | All `theme.change` events appear in `/api/audit` with the resolved before/after values and `subBrandId` when applicable |

---

## 7. Out of Scope

- Custom theme creation (operators authoring their own color palettes) — separate feature; tracked under future PRD if requested
- Auto day/night transition (sunset-based, geo-aware) — Phase 2; not in this scope
- Per-page theme overrides (e.g. "Reports always dark even when I'm in light mode") — explicitly out; would conflict with the consistency the toggle delivers
- High-contrast / WCAG-AAA / colorblind-safe themes — belongs in a dedicated a11y PRD
- Customer-side (portal-visitor) personal theme preference — sub-brand default is the contract; no per-visitor override
- Mobile-app theme — out of scope for this PRD; the CRM web client is the target

---

## 8. Dependencies

**Existing surfaces extended (no new module needed):**
- `frontend/src/App.jsx` theme useEffect — extend to (a) fetch user prefs on login, (b) re-render on sub-brand context change, (c) consume server pref over localStorage when both exist
- `frontend/src/pages/Settings.jsx` Appearance picker — extend to (a) show sub-brand override picker, (b) "Apply to all sub-brands" button, (c) "currently inherited from tenant default" indicator
- `frontend/index.html` inline FOUC seed script — extend to (if auth cookie present) make a synchronous fetch to `/api/users/me/preferences/theme` and prefer that over localStorage
- `Tenant.subBrandConfigJson` (existing slot from `621aab7`) — already nominally supports per-sub-brand theme; this PRD makes it formal

**New schema (additive, nullable, no bless markers required):**
- `User.themePreference` enum — additive nullable column
- `User.subBrandThemeOverrides` JSON — additive nullable column
- `Tenant.defaultThemePreference` enum — additive nullable column
- `Tenant.featureFlags.themeManagementV2` boolean — for gradual rollout

**Sibling PRDs:**
- `PRD_TRAVEL_PER_SUBBRAND_BRANDING.md` — owns the brand kit palette source-of-truth; this PRD references it for "which palette does a sub-brand resolve to"
- `PRD_DARK_MODE_CLUSTER.md` — owns the per-page CSS surface work (what colors render in dark mode); orthogonal but adjacent
- `PRD_MOBILE_RESPONSIVENESS.md` — tangentially related (mobile theme toggle placement)

**Routes added:**
- `PATCH /api/users/me/preferences` — write user pref (theme + future prefs slot in here)
- `GET /api/users/me/preferences` — read full pref bundle (called once on login, batched with other prefs)
- `PATCH /api/tenants/me/default-preferences` — tenant-admin route for tenant defaults (RBAC gated to ADMIN)

---

## 9. Open Questions

| ID | Question |
|---|---|
| OQ-9.1 | Toggle UI: 2-state (light/dark only — system mode is power-user) vs 3-state (light/dark/system)? Settings picker is 3-state; should toggle match? |
| OQ-9.2 | If a user has per-sub-brand overrides AND the tenant default differs from their global pref → who wins on a sub-brand the user has NOT explicitly overridden? Recommend: user's global preference (per-sub-brand overrides are explicit opt-ins). |
| OQ-9.3 | What if a user accesses a sub-brand they don't have access to (`subBrandAccess[]` excludes it) — should the theme still apply, or fall back to tenant default? |
| OQ-9.4 | Mobile (responsive web on phone): separate theme picker presence OR inherit from desktop session? |
| OQ-9.5 | Roaming across SSO sessions (SAML / OAuth): preserve preference (same userId) or reset on every fresh SSO login? Recommend: preserve. |
| OQ-9.6 | Customer portal sub-brand resolution when the visitor is anonymous (no `userId`): theme from URL-derived sub-brand only? |
| OQ-9.7 | "Apply to all sub-brands" — does it overwrite existing per-sub-brand picks silently, or warn first? |

---

## 10. Status Snapshot

| Field | Value |
|---|---|
| **Current state** | Client-only persistence (localStorage); App.jsx applies theme via useEffect; matchMedia listener for system-pref reactivity; tick #19 (`f9bd2c3`) closed `#868` FOUC; Settings.jsx exposes 3-option picker |
| **This PRD written** | 2026-05-23 (cron tick #26) |
| **Sibling PRDs** | `PRD_DARK_MODE_CLUSTER.md` (per-page CSS surface), `PRD_TRAVEL_PER_SUBBRAND_BRANDING.md` (brand-kit palette source) |
| **Issues coordinated** | `#862` (toggle UI) + `#870` (server persistence / BUG-T04) + `#876` (per-sub-brand / BUG-T06) |
| **Path to implementation** | 8-15 engineering days, gated on the 6 design decisions in §5 — most of the cost is the per-sub-brand resolution + migration discipline, not the toggle UI itself |
| **Phase split (recommended)** | Phase A: in-app toggle (#862, ~1 day) → Phase B: server persistence (#870, ~3-5 days) → Phase C: per-sub-brand (#876, ~4-9 days) |
| **Hard gates** | DD-5.2 (user vs tenant precedence) + DD-5.3 (per-sub-brand opt-in vs auto) — without these decided, FR-3.2 and FR-3.3 cannot ship safely |

---

*PRD owner: Globussoft engineering. Sign-off required from Yasin (Travel CRM
operator persona) on §5 design decisions and Suresh (Technical Architect)
on the §8 schema additions before Phase A begins.*

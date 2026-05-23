# PRD — Mobile Responsiveness (Cross-Cutting)

**Status:** DRAFT • **Owner:** Frontend platform squad • **Filed:** 2026-05-23 (tick #25)
**Refs:** GH #910 (P3 Travel Gap — Mobile responsiveness) • Travel Stall CRM Roadmap Tier P3 item 15
**Siblings:** [PRD_TRAVEL_B2B_AGENT_PORTAL.md](PRD_TRAVEL_B2B_AGENT_PORTAL.md) (portal MUST be mobile-friendly) • [PRD_TRAVEL_PER_SUBBRAND_BRANDING.md](PRD_TRAVEL_PER_SUBBRAND_BRANDING.md) (brand kit renders at mobile breakpoints too)

---

## §1 Background + source attribution

The CRM was built desktop-first (1280px+ target) over ~3 years; 100+ pages now exist. Operator workflows have shifted materially toward mobile + tablet: TMC field reps log school-visit notes on phones between meetings, RFU pilgrim-companion staff respond to on-tour incidents from their phones in Makkah, Travel Stall remote agents quote-build from iPads at home, and after-hours admin approvals routinely happen on phones. The current state is patchy — some pages have full responsive treatments (the wellness "demo path" 6 are well-covered via `frontend/src/styles/responsive.css`), some have none, and there is no tenant-wide responsive strategy or cross-page audit. Customers reaching the customer portal on phones (their default device) hit the same single-codebase pages built for laptop screens.

This PRD scopes a cross-cutting program: breakpoint strategy, per-page priority audit, component-level patterns, navigation pattern, touch-friendly defaults, mobile-performance budget, and a phased rollout. It is a strategy + checklist, not a feature spec — implementation is multi-day cross-cutting work (~30-60 engineering days for full P0+P1).

### §1.2 Existing infrastructure (do NOT rebuild)

| Asset | Location | Status |
|---|---|---|
| `MOBILE_BREAKPOINT_PX = 900` | `frontend/src/components/Layout.jsx:82` | Shared JS breakpoint used by `matchMedia` for drawer/sidebar swap |
| `frontend/src/styles/responsive.css` | shipped #228 + T2.1 | Sidebar drawer + 6 wellness pages (OwnerDashboard / Patients / PatientDetail / Calendar / Reports / TelecallerQueue) + global modal clamp |
| `.app-sidebar` drawer pattern | `responsive.css:23-67` | Off-canvas slide-in with backdrop + 240ms ease; activated below 899px |
| `.sidebar-backdrop` | `responsive.css:27-37` | Dim-overlay + blur backdrop for drawer |
| `.sidebar-toggle` | `responsive.css:43-47` | Hamburger toggle baseline; 44×44 at mobile (WCAG 2.5.5 compliant) |
| Generic safety-net selectors | `responsive.css:203-218` | Catches `minmax(320/340/360px, 1fr)` grids + `display: flex` + `gap` rows without per-page migration |
| `<=380px` narrow clamps | `responsive.css:227-256` | iPhone SE / Galaxy S8 width — collapses 200/220/240/260px auto-fit grids to 1 column |
| `data-vertical="travel"` / `data-vertical="wellness"` | `App.jsx` body attribute | Sub-theme scoping that mobile rules can stack on top of |
| Wellness `data-vertical="wellness"` theme | `frontend/src/theme/wellness.css` | Brand palette; already plays with mobile drawer |
| Travel placeholder theme | `frontend/src/theme/travel.css` | Travel navy/gold placeholder; expects same mobile treatment |
| CLAUDE.md standing pattern | `gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))'` | Single-source responsive grid with no media-query needed; partial adoption |
| Playwright config | `e2e/playwright.config.js` | Single chromium project today; mobile/tablet viewport projects need adding |
| Sidebar render branches | `frontend/src/components/Sidebar.jsx` | Generic / wellness / travel branches all need mobile drawer respect |

### CRM-wide gaps (the why)

- **No documented breakpoint strategy** — `MOBILE_BREAKPOINT_PX = 900` is the only canonical number; 380px and 1024px appear in CSS but aren't named/tracked.
- **Patchy per-page work** — only 6 wellness pages have explicit mobile fixes; remaining 100+ are "works because auto-fit grids reflow" or "doesn't work, never tested".
- **No mobile QA discipline** — no Playwright mobile project, no Lighthouse mobile budget; mobile regressions land silently.
- **Tap-target compliance unverified** — WCAG 2.5.5 wants 44×44; only the sidebar toggle is explicitly sized. Buttons, badges, table-row links across pages likely under 44px.
- **Tables don't card-down** — current treatment is "wrap in horizontal scroll", which works but is poor UX vs the standard list-as-cards mobile pattern.
- **No bottom-tab-bar** — drawer is the only nav primitive; serious mobile UIs use bottom-tab-bar for 1-tap access to top-5 destinations.
- **No PWA install / offline** — mobile users can't add-to-home-screen; no service worker; no offline-read mode.
- **Customer portal is mobile-critical but treated the same** — `/portal` views are the customer-facing surface and overwhelmingly hit from phones; warrants stricter mobile attention than operator pages.
- **Brand themes (wellness/travel) re-define palette but not breakpoint behaviour** — mobile rules currently live in one global file; sub-brand mobile overrides aren't a thing.

### Source attribution

- GH #910 ACs: "Audit every module for mobile breakpoints, fix priority screens, and validate on iPhone Safari and Android Chrome. Priority screens: Inbox, Tasks, Leads (create/convert), Trip detail (Participants + Payment plan)."
- Travel Stall CRM Roadmap Tier P3 item 15.

---

## §2 Use cases

- **UC-2.1** TMC field rep finishes a school visit at 3pm → opens CRM on her phone in the school parking lot → logs a meeting note + advances the deal stage in <60s without zooming.
- **UC-2.2** RFU pilgrim-companion staff in Makkah → opens CRM on phone at 2am local → looks up a pilgrim's emergency contact + sends a templated SMS in <30s on weak 3G.
- **UC-2.3** Travel Stall remote agent on iPad at home → builds a quote in the quote-builder + sends the PDF for client signature — full flow on tablet without falling back to desktop.
- **UC-2.4** Admin on the train → opens phone → checks weekly digest, approves an expense exception, closes the app — 2 minute round-trip.
- **UC-2.5** Customer on phone → opens portal link from booking-confirmation email → views trip details + downloads itinerary PDF on phone safari.
- **UC-2.6** Sub-agent on tablet → opens B2B portal (per sibling PRD) → builds a quote for a travel-agent client + sends confirmation; experience parity with desktop.
- **UC-2.7** Pilgrim companion uses phone camera to scan a passport (Phase 2 mobile-only feature) — would be impossible on desktop.

---

## §3 Functional requirements

### FR-3.1 Breakpoint strategy

- **(a)** **Mobile (< 640px)** — phones in any orientation. Single-column layouts default; drawer nav; full-screen modals; card lists (not tables); compact spacing.
- **(b)** **Tablet (640-1024px)** — iPad portrait/landscape; small Android tablets; phones in landscape mode. 2-column layouts allowed; drawer nav stays below 900 per current `MOBILE_BREAKPOINT_PX`; dialog modals can stay centred; tables allowed with horizontal scroll.
- **(c)** **Desktop (≥ 1024px)** — current default behaviour; sidebar static; tables native; modals centred dialogs.
- **(d)** **Canonical breakpoint constants** — exported from `frontend/src/styles/breakpoints.js` so JS (matchMedia) + CSS (custom-property fed via `:root`) stay in sync; replaces the current scattered `899px` / `900px` / `768px` / `380px` numbers. Values: `MOBILE_MAX = 639`, `TABLET_MAX = 1023`, `DESKTOP_MIN = 1024`, plus `NARROW_MAX = 380` for iPhone-SE class clamps.
- **(e)** **Per-breakpoint behaviour documented per page** in the per-page audit doc (`docs/MOBILE_PAGE_AUDIT.md` — sibling doc, written alongside implementation).

### FR-3.2 Per-page priority + audit

- **(a)** **P0 — must work flawlessly on mobile** (10-15 pages): Login, Dashboard (generic + wellness OwnerDashboard + travel landing), Calendar, Notifications, Inbox/SharedInbox, Profile, Tasks, Leads (create + convert), Trip detail (Participants + Payment plan — explicit GH #910 callout), Patient portal (public), `/book/:slug` public booking, customer portal.
- **(b)** **P1 — should work well on tablet, acceptable on mobile** (~40 pages): all Deal/Contact/Lead detail pages, Itinerary view, Quote builder, all PatientDetail tabs, Pipeline/Pipelines, B2B portal (per sibling PRD).
- **(c)** **P2 — desktop-only acceptable, degrade gracefully on mobile** (~30 pages): Reports / CustomReports / AgentReports, Settings, Bulk operations / CSV import, Audit log / Privacy, Workflows / Sequences builders, Landing page builder, ChartBuilders, ReportSchedules.
- **(d)** **P3 — not mobile-critical at all** (~15 pages): Developer, Sandbox, IndustryTemplates, DocumentTemplates (template authoring), FieldPermissions, Marketplace integrations admin, SCIM, SSO admin.
- **(e)** **Audit format** — `docs/MOBILE_PAGE_AUDIT.md` lists each page with: priority tier, current status (Pass/Partial/Fail) at 375px/768px/1024px, gap notes, owning engineer, target ship date.

### FR-3.3 Component-level responsive patterns

- **(a)** **Sidebar → hamburger drawer on mobile** — already shipped at `<=899px`; extend to all 3 verticals (generic/wellness/travel) without regression. Drawer width 280px, max-width 85vw, backdrop blur preserved.
- **(b)** **Tables → cards on mobile** — currently tables horizontal-scroll; the canonical mobile pattern is one row → one card with key fields stacked + secondary fields collapsed under "Show more". Shared `<MobileCardRow>` component, opt-in per-table.
- **(c)** **Modals → full-screen on mobile, dialog on desktop** — already shipped via `responsive.css:102-110` global modal clamp; verify DealModal + EmailSignatureEditor + all `[class*="modal-content"]` patterns honour it.
- **(d)** **Forms → stack labels above inputs on mobile, side-by-side on desktop** — shared `.form-row` utility class with `flex-direction: column` at mobile, `row` at desktop. Inputs full-width on mobile.
- **(e)** **Charts → simplified / collapsed legends on mobile** — Recharts components accept `ResponsiveContainer`; pass a per-breakpoint `legend.layout` prop. Sparkline charts kept; bar/line charts gain a "mobile legend below chart" treatment.
- **(f)** **KPI tiles** — 4-up on desktop, 2-up on tablet, 1-up on mobile via `repeat(auto-fit, minmax(min(100%, 240px), 1fr))` (CLAUDE.md standing pattern) — adopt across remaining Dashboard / Forecasting / Currencies / Quotas / Payments / WebVisitors / WinLoss / Privacy / DocumentTracking / OwnerDashboard / PatientsList / Visits / PerLocationDashboard call sites.

### FR-3.4 Navigation

- **(a)** **Bottom tab bar on mobile** (5 most-used destinations) — visible only at `<= MOBILE_MAX`. Default tabs are user-configurable; defaults per vertical:
  - Generic: Dashboard / Inbox / Tasks / Deals / Profile
  - Wellness: OwnerDashboard / Calendar / Patients / TelecallerQueue / Profile
  - Travel: Dashboard / TripDetail / Inbox / Quotes / Profile
- **(b)** **Top breadcrumb on tablet** — page-context breadcrumb anchored under the top header; replaces the always-on sidebar item highlight as the wayfinding cue when sidebar is collapsed.
- **(c)** **Pull-to-refresh on list views** — Inbox, Tasks, Leads, Notifications, Calendar day-view, TelecallerQueue. Use `react-pull-to-refresh` or equivalent; trigger the page's existing fetch hook.
- **(d)** **Swipe gestures** — swipe-to-archive (Inbox), swipe-to-delete (Tasks/Notifications), swipe-to-call (LeadDetail dispositions). Library: `react-swipeable`.
- **(e)** **Back-button + browser-history discipline** — drawer/modal open states encoded in URL hash so the browser back button closes them instead of leaving the page.

### FR-3.5 Touch-friendly defaults

- **(a)** **Minimum 44×44px tap targets** (Apple HIG + WCAG 2.5.5) — audit every `<button>`, `<a>`, table-row link, icon button; pad to 44×44 minimum on mobile. Sidebar toggle already does this.
- **(b)** **Spacing ≥ 8px between adjacent interactive elements** — prevents fat-finger mis-taps. Audit form rows, button groups, tab strips.
- **(c)** **Long-press for context menus** — replaces right-click on mobile. Use `react-aria` long-press detection. Applies to row actions (e.g. lead-row → long-press → quick-disposition).
- **(d)** **Hover states gracefully degrade** — `@media (hover: hover)` wrappers around every `:hover` rule; on mobile, hover-only-tooltips become tap-then-display.
- **(e)** **No double-tap-to-zoom suppression unless safe** — viewport `user-scalable=no` is an a11y anti-pattern (blocks zoom); only suppress double-tap on specific gesture surfaces (e.g. signature canvas) via touch-action CSS.

### FR-3.6 Mobile performance

- **(a)** **Lazy-load below-fold content** — already in use via React.lazy + Suspense for routes; extend to large widgets within a page (e.g. RecentActivity feed on Dashboard).
- **(b)** **Responsive image srcset** — all `<img>` tags adopt `srcset` + `sizes` to ship 1× / 2× / 3× per device pixel ratio. Logo + hero + portal hero specifically.
- **(c)** **Skeleton loaders** — every list view + every dashboard widget renders a skeleton during fetch instead of spinner-only. Reduces perceived load time on weak networks. Already partial — extend to every P0/P1 page.
- **(d)** **Offline mode** — Phase 2 scope. Service worker caches last-viewed list + detail pages; read-only sync; "you're offline — last sync 5 min ago" banner.
- **(e)** **PWA install prompt** — Phase 2 scope. Web manifest + service worker + `BeforeInstallPromptEvent` capture; show install prompt on second visit per DD-5.4.
- **(f)** **Network-aware code paths** — `navigator.connection.effectiveType === '2g'` triggers lower-resolution image variants + disables auto-refresh polls.

### FR-3.7 Testing surface

- **(a)** **Playwright mobile + tablet projects** — extend `e2e/playwright.config.js` to ship 3 projects: `chromium-desktop` (current), `chromium-mobile` (375×667 iPhone SE 2nd gen UA), `chromium-tablet` (768×1024 iPad UA). All gate-required specs run against all 3 projects.
- **(b)** **Visual regression on mobile** — Percy.io or Playwright screenshot diff on key P0 pages at 375px + 768px + 1024px; flags any layout shift between commits.
- **(c)** **Manual QA per breakpoint per P0 page** — pre-release checklist; QA confirms iPhone Safari + Android Chrome behaviour on every P0 page before sign-off.
- **(d)** **Lighthouse mobile budget per page** — CI step runs Lighthouse mobile (4G network, Moto G4 device) on top-10 P0 pages; budget enforced: Performance ≥ 70, Accessibility ≥ 90, Best Practices ≥ 90.
- **(e)** **Real-device smoke** — per-release on iPhone (SE + 14) + Android (Pixel 6 + low-end Samsung) before tagging.

---

## §4 Non-functional

- **Time-to-interactive on mobile:** ≤ 3s on 4G (Moto G4 baseline). Current desktop TTI ≈ 1.2s.
- **Accessibility:** WCAG-AA on all P0 pages at mobile breakpoint; per-page audit doc records contrast ratios + tap-target sizes.
- **Performance budget:** ≤ 200KB gzipped JS per route (initial bundle); ≤ 100KB CSS total; ≤ 500KB images per page on mobile.
- **No layout shift:** Cumulative Layout Shift (CLS) < 0.1 on all P0 pages.
- **Compatibility:** iOS Safari ≥ 15, Chrome Mobile ≥ 100, Samsung Internet ≥ 18. No IE/Edge-Legacy support.
- **Touch latency:** ≤ 100ms from tap to visual feedback (active state).
- **Network resilience:** all read endpoints retry once on transient failure; mutations show queue-pending state if offline.
- **Battery:** no continuous polling on mobile; switch to socket.io presence + push for live updates.

---

## §5 Hand-over reqs / cred chase / design decisions

### Design decisions (need product + design sign-off)

- **DD-5.1 Mobile nav pattern: bottom-tab-bar / hamburger-only / hybrid?** — Recommendation: **hybrid** — hamburger drawer for full nav (50+ items in generic vertical), bottom-tab-bar for top-5 destinations. Industry standard for sidebar-heavy CRMs.
- **DD-5.2 Mobile-first or desktop-first CSS?** — Recommendation: **stay desktop-first** (current default), opt-in to mobile-first only for new components built from scratch. Migration cost of flipping 100+ pages outweighs ergonomic gain.
- **DD-5.3 Tablet treatment: closer to mobile or desktop?** — Recommendation: **closer to desktop** above 900px (current `MOBILE_BREAKPOINT_PX`), closer to mobile below. iPad in landscape (1024px) gets full desktop; iPad in portrait (768px) gets mobile drawer + tablet 2-up grids.
- **DD-5.4 Offline-mode scope: read-only vs limited-write?** — Recommendation: **read-only Phase 2**, write-queue Phase 3. Write-conflict resolution + multi-device sync is a multi-month project.
- **DD-5.5 Per-page degradation: hide features or simplify?** — Recommendation: **simplify before hide**. Bulk operations + multi-select on mobile can collapse to "tap one item at a time" rather than disappearing.
- **DD-5.6 PWA install prompt timing** — never on first visit (annoys casual visitors), prompt on second visit with banner, dismiss for 30 days if declined.
- **DD-5.7 Bottom-tab-bar contents per vertical** — defaults proposed in FR-3.4(a); confirm with product per-vertical usage data.
- **DD-5.8 Customer portal: same codebase or separate mobile-optimised build?** — Recommendation: **same codebase**, with `data-surface="portal"` attribute scoping aggressive mobile styles. Separate build doubles maintenance.

### Cred / vendor chase

- **None external.** Mobile responsiveness is pure frontend work; no third-party SDK required beyond Playwright's mobile UAs + Lighthouse-CI.
- **Browser-stack / Sauce Labs subscription** — optional, ~$150/mo, for real-device cross-browser testing. Not blocking; manual real-device suffices for Phase 1.

### Vendor / spec docs

- Apple Human Interface Guidelines — touch targets, gestures, safe areas.
- Material Design Mobile — bottom-nav patterns, FAB conventions, swipe gestures.
- WCAG 2.1/2.2 — mobile accessibility specifics (2.5.5 target size, 1.4.10 reflow, 1.3.4 orientation).
- Google Web.dev — Core Web Vitals mobile-specific guidance.

---

## §6 Acceptance criteria

- **AC-6.1** Login page renders correctly on 375px-wide viewport (iPhone SE 2nd gen) — form inputs full-width, "Quick login" buttons stack 1-up, no horizontal scroll.
- **AC-6.2** Dashboard KPI tiles stack 1-up on mobile (<640px), 2-up on tablet (640-1024px), 4-up on desktop (≥1024px).
- **AC-6.3** Sidebar collapses to hamburger drawer below 900px (current `MOBILE_BREAKPOINT_PX`); backdrop appears; click-outside closes drawer; browser back button closes drawer.
- **AC-6.4** Deal list view renders as cards (1-up) on mobile, table on desktop; per-card actions accessible via tap (no hover-only menus).
- **AC-6.5** All modals (DealModal, Record Payment, Edit Profile, EmailSignatureEditor) full-screen on mobile per `responsive.css:102-110` global clamp.
- **AC-6.6** All tap targets ≥ 44×44px on P0 pages — verified via axe-core + Lighthouse a11y audit.
- **AC-6.7** Playwright test suite passes for `chromium-mobile` + `chromium-tablet` projects across the P0 page list.
- **AC-6.8** Lighthouse mobile Performance score ≥ 70 + Accessibility ≥ 90 on the top-10 P0 pages.
- **AC-6.9** Customer portal `/portal/*` + public booking `/book/:slug` renders correctly on iPhone Safari + Android Chrome — manually verified per release.
- **AC-6.10** Trip detail page (GH #910 explicit callout) renders Participants list + Payment plan on 375px viewport without truncation.

---

## §7 Out of scope

- **Native mobile app** (React Native / Flutter / Swift / Kotlin) — separate scope. PWA is in-scope (Phase 2); native is not.
- **Offline-mode write** (write-conflict resolution + multi-device sync) — Phase 3 only; Phase 2 ships read-only offline.
- **iPad-specific gestures** (Apple Pencil drawing, multitouch gestures beyond pinch/swipe) — out of scope.
- **Watch / Wear OS / TV / Auto** — out of scope.
- **Refactor every page to mobile-first CSS** — DD-5.2 says desktop-first stays as default; mobile-first only for new components.
- **Replace the entire CSS architecture** (e.g. migrate to Tailwind) — out of scope; this PRD extends the existing vanilla-CSS approach.
- **Mobile-only features beyond what this PRD lists** (e.g. camera-based passport OCR — separate `PRD_PASSPORT_OCR.md`) — out of scope.
- **Per-tenant nav-pattern customisation** (OQ-9.2 punted) — out of scope Phase 1.

---

## §8 Dependencies

- **Layout.jsx** (existing — extend with bottom-tab-bar + breakpoint export from `breakpoints.js`).
- **CSS architecture** (existing `theme/wellness.css`, `theme/travel.css`, `styles/responsive.css`, `index.css`) — extend, do not rewrite.
- **Playwright test infrastructure** (existing — extend `playwright.config.js` to add mobile + tablet projects; existing test specs may need viewport-conditional skips for desktop-only flows).
- **React Router + React.lazy** (existing — already code-splits at route level; extend to widget level for mobile lazy-load).
- **Recharts** (existing — already supports `ResponsiveContainer`; extend Charts with mobile legend variants).
- **`subBrandConfig.js` + brand-kit fields** (per sibling PRD) — mobile rules MUST honour sub-brand context.
- **`<MobileCardRow>` shared component** — new; must ship before per-page table → card migrations.
- **`breakpoints.js`** — new shared JS/CSS source of truth.
- **`react-pull-to-refresh` + `react-swipeable` + `react-aria` long-press** — new npm dependencies (verify audit-allowlist before adding).
- **Workflow manifest + service worker** (Phase 2 PWA) — new.
- **Lighthouse-CI** — new GitHub Actions step for the mobile-budget gate.

---

## §9 Open questions

- **OQ-9.1** Which 5 pages should be on the bottom-tab-bar — defaults proposed in FR-3.4(a) but final list TBD via usage-data analytics from past 90 days per vertical.
- **OQ-9.2** Multi-tenant: do tenants pick their own preferred nav pattern (hamburger vs hybrid vs bottom-only)? — Punted to Phase 2; Phase 1 ships hybrid as the only option.
- **OQ-9.3** Per-vertical mobile UX — does wellness's clinic-focused workflow want different defaults than travel's field-rep workflow? FR-3.4(a) proposes per-vertical bottom-tab defaults; deeper per-vertical divergence (e.g. wellness gets calendar-first, travel gets trip-first) is open.
- **OQ-9.4** PWA install prompt: opt-in setting or default-prompt? — DD-5.6 proposes default-prompt on 2nd visit + dismiss-for-30-days; product validation needed.
- **OQ-9.5** Mobile-only features: should we ship camera (barcode scanner, passport OCR, receipt scan)? — Each is a separate PRD (already exists for passport OCR); not blocking this PRD but the mobile codebase MUST be ready to surface them.
- **OQ-9.6** Do we support landscape on phones? — Edge case; tested on iPhone in landscape (667×375). Recommendation: yes, treat as mobile + horizontal scroll where needed. Not a primary support target.
- **OQ-9.7** Print-stylesheet parity — current PDF rendering goes through `pdfRenderer.js` not browser-print. Should mobile users have a "print this page" option that fans out to email-PDF instead? — Probably yes; out of scope this PRD.
- **OQ-9.8** Operator app vs customer app — customer portal is a strict subset; should we eventually fork them so the portal can ship a 50KB-JS bundle independent of the operator pages? — Phase 3 consideration; not Phase 1.

---

## §10 Status snapshot

- **Current:** patchy per-page responsive work; only 6 wellness pages explicitly mobile-treated via `responsive.css` (OwnerDashboard / Patients / PatientDetail / Calendar / Reports / TelecallerQueue) + global modal clamp + sidebar drawer below 899px + generic safety-net selectors for `minmax(320/340/360px)` grids. No tenant-wide responsive strategy, no Playwright mobile coverage, no Lighthouse mobile budget. `MOBILE_BREAKPOINT_PX = 900` is the only shared constant.
- **This PRD:** WRITTEN 2026-05-23 (tick #25).
- **Path to implementation:** ~30-60 engineering days for full P0 + P1 coverage; cross-cutting work spanning all frontend pages.
- **Phased rollout:**
  - **Phase 1A — Foundation (5 days):** ship `breakpoints.js`, `<MobileCardRow>` component, extend `playwright.config.js` with mobile+tablet projects, audit doc `MOBILE_PAGE_AUDIT.md`.
  - **Phase 1B — P0 pages (10 days):** Login / Dashboard / Calendar / Notifications / Inbox / Profile / Tasks / Leads / Trip detail / Customer portal / Public booking — all green on mobile + tablet.
  - **Phase 1C — Bottom-tab-bar + drawer polish (5 days):** ship bottom-tab-bar component, extend drawer to all 3 verticals' sidebars without regression.
  - **Phase 1D — P1 pages (20 days):** all Deal/Contact/Lead detail pages, Itinerary view, Quote builder, PatientDetail tabs, Pipeline pages, B2B portal.
  - **Phase 1E — Component-level patterns (10 days):** tables → cards opt-in, forms label-stack, charts mobile-legend, tap-target audit + fixes.
  - **Phase 1F — Test coverage + Lighthouse-CI (10 days):** Playwright suite green on mobile + tablet projects; Lighthouse mobile budget enforced in CI.
  - **Phase 2 (later, 4-8 weeks):** PWA install + read-only offline + service worker.
  - **Phase 3 (later, 2-4 months):** write-queue offline, multi-device sync.
- **Sibling PRDs:**
  - [PRD_TRAVEL_B2B_AGENT_PORTAL.md](PRD_TRAVEL_B2B_AGENT_PORTAL.md) — B2B portal MUST be mobile-friendly Phase 1 (consumes this PRD's `<MobileCardRow>` + breakpoint constants).
  - [PRD_TRAVEL_PER_SUBBRAND_BRANDING.md](PRD_TRAVEL_PER_SUBBRAND_BRANDING.md) — brand kit renders at mobile breakpoints; sub-brand mobile overrides plug under `data-vertical="travel"` per-sub-brand-data-attribute scope.
  - [PRD_PASSPORT_OCR.md](PRD_PASSPORT_OCR.md) — camera-based feature relying on this PRD's mobile foundation.

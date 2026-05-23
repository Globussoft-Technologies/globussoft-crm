# Wellness POS Hardening — Product Requirements

**Status:** SPEC — coordinating PRD written 2026-05-23 (cron tick #27). Sibling
to `PRD_TRAVEL_SECURITY_ARCHITECTURE.md` (same coordinating-PRD shape) and
`PRD_THEME_MANAGEMENT.md` (also a coordinating PRD over 3 related issues).

**Coordinates 4 OPEN GH issues from the May 2026 Enhanced Wellness demo audit:**
- `#823` — `/pos` direct URL returns 404 (missing `/wellness` prefix)
- `#824` — POS sidebar click intermittently renders 404 instead of shift screen
- `#826` — Owner blocked from POS by "No registers configured — ask an admin"
- `#830` — Demo User: POS menu visible but role cannot complete a sale

**Audience:** GS frontend + backend engineers implementing the routing fix +
RBAC clean-up + Register onboarding wizard; QA verifying the end-to-end sale
flow per role; PM / Rishu for the design-decision sign-off.

---

## 1. Background

The CRM ships a working POS backbone (Wave 2 Agent II — `routes/pos.js` 1,079
lines, `PointOfSale.jsx` 1,146 lines, 17 endpoints across Register / Shift /
Sale / petty-cash / refund). The Register + Shift + Sale + PettyCashLedger
Prisma models are healthy with proper tenant scoping, audit emission, and a
polymorphic SaleLineItem. The May 2026 demo audit nonetheless surfaced four
distinct user-journey breaks that prevent any role from completing a sale
against a fresh tenant:

1. **Routing** (#823, #824) — direct `/pos` URL 404s; sidebar click occasionally
   renders the 404 view instead of the POS page even when the URL resolves
2. **RBAC** (#830) — Demo User sees POS in the sidebar but the page dead-ends
   on Register configuration
3. **Onboarding state** (#826) — Owner (Rishu) — the highest role — is told
   "ask an admin to create a Register first" with no in-product path to do so

These are inter-related: the routing bugs prevent any operator from reaching
POS reliably; the RBAC + onboarding bugs prevent the operator from completing
a sale once they get there. A single hardening pass closes all 4 + likely
prevents the same shape of regression on the next vertical's POS-like surface.

### 1.1 Source attribution

- `#823` filed via Enhanced Wellness QA audit 2026-05-21 (Rishu's session against `crm-staging.globusdemos.com`)
- `#824` same audit — sidebar click race
- `#826` same audit — Owner onboarding dead-end
- `#830` same audit — Demo User dead-end
- Companion `/reports/pnl` 404 bug noted in `#823` body is in scope of the broader routing-prefix design conversation but tracked separately

### 1.2 Existing infrastructure (do NOT rebuild)

| Surface | Where it lives | What it does |
|---|---|---|
| POS page component | `frontend/src/pages/wellness/PointOfSale.jsx` (1,146 lines) | Shift open/close UI, line-item cart, payment-method picker, sale complete |
| POS route mount | `frontend/src/App.jsx:1154` (`wellness/pos`) | Wellness-only, RoleGuard `["ADMIN","MANAGER","USER"]` |
| Cash Registers admin page | `frontend/src/App.jsx:1166` (`wellness/cash-registers`) | Admin CRUD for Registers, shift detail drill-down |
| Sidebar entry | `frontend/src/components/Sidebar.jsx:827` | Links to `/wellness/pos` under FINANCE bucket |
| Backend route file | `backend/routes/pos.js` (1,079 lines) — mounted at `/api/pos` | 17 endpoints |
| Backend role gates | `routes/pos.js:42-50` — `adminGate` (admin/manager) + `cashierGate` (admin/manager/doctor/professional/telecaller/helper) | Wellness-vertical-gated via `verifyWellnessRole` |
| Prisma models | `Register`, `Shift`, `Sale`, `SaleLineItem`, `PettyCashLedger` (`schema.prisma:3752-3828`) | Tenant-scoped, audit-emitting, fully migrated |
| Audit emission | `writeAudit('Register' \| 'Shift' \| 'Sale', ...)` at every mutation | Captured in hash-chain |
| Sale loyalty hook | `maybeAutoCreditLoyaltyForSale` in `routes/pos.js:68` | Credits loyalty points on `COMPLETED` sale |
| Invoice numbering | `formatInvoiceNumber` / `generateInvoiceNumber` (tenant-scoped `POS-YYYY-NNNN`) | Per-tenant monotonic |

**The work in this PRD is additive on top of all of the above** — none of
these surfaces gets ripped out. Specifically: there is no missing endpoint,
no missing Prisma model, no missing audit-emit. The four bugs are about
routing wiring, role visibility, and onboarding ergonomics.

---

## 2. Use Cases

| # | Persona | Story |
|---|---|---|
| UC-2.1 | Counter operator | Type `/pos` into the browser address bar → POS screen loads (no 404) (#823) |
| UC-2.2 | Owner (Rishu) | Click "Point of Sale" in sidebar → POS screen renders on first click + every subsequent click (#824) |
| UC-2.3 | First-time tenant Owner | Open POS on a never-configured tenant → in-line wizard creates default Register + opens first Shift (no logout-login cycle, no "ask an admin" dead-end) (#826) |
| UC-2.4 | Cashier (Demo User staff role) | Open shift → ring up a sale → complete it → receipt PDF generated → inventory + ledger update (#830) |
| UC-2.5 | Multi-register tenant | Cashier picks which register on shift open (multiple Registers across multiple Locations) |
| UC-2.6 | Admin disabling POS | Tenant with no POS needs → admin toggles "POS module" off → sidebar entry hidden, `/wellness/pos` redirects to dashboard |
| UC-2.7 | Browser back/forward | Operator on sale-detail page → browser back → POS shift screen (not 404) |

---

## 3. Functional Requirements

### FR-3.1 Routing fixes (#823 #824)

- **(a)** `/pos` (no prefix) routes correctly under the wellness vertical. Two
  implementation paths considered (see DD-5.1): (i) permanent redirect from
  `/pos` → `/wellness/pos` for wellness-vertical tenants; (ii) mount POS at
  `/pos` directly (drop `/wellness/` prefix). Pick one in DD-5.1.
- **(b)** Sidebar "Point of Sale" click → POS page renders on first click +
  every subsequent click. Root-cause the intermittent 404 (#824 notes: "first
  click 404s, second click works" — suggests a route-match race against
  initial bundle load or stale React.lazy chunk).
- **(c)** Browser back/forward across POS sub-routes (`/wellness/pos`,
  `/wellness/cash-registers`, `/wellness/cash-registers/:id`) navigates
  correctly with no 404 view.
- **(d)** Instrument client-side router to log failed-match events to Sentry
  + browser console with the attempted path + the matched-or-not result —
  catches future regressions of this shape.
- **(e)** New e2e spec `pos-routing-api.spec.js` covering 5 navigation paths:
  direct `/pos` URL, direct `/wellness/pos` URL, sidebar click, browser-back
  after sale, deep-link to sale detail.

### FR-3.2 RBAC + role visibility (#830)

- **(a)** Sidebar "Point of Sale" entry visibility is conditional on the
  user's role having any `cashierGate`-acceptable role
  (admin/manager/doctor/professional/telecaller/helper) **AND** the tenant
  having POS enabled (FR-3.3 (c)). Plain `USER` without a
  `wellnessRole` should not see the entry.
- **(b)** Frontend `RoleGuard` allow-list at `App.jsx:1156` widens from
  `["ADMIN","MANAGER","USER"]` to align with backend `cashierGate` — the
  backend already accepts the wider role bucket; the frontend should not be
  stricter.
- **(c)** Role-based UI affordance — buttons / fields the current role cannot
  action are hidden, not just disabled. (e.g. cashier should not see
  "Refund" — that's admin/manager only per `routes/pos.js:1035`.)
- **(d)** "Demo User" seed (`prisma/seed-wellness.js`) gets a `wellnessRole`
  assigned so the demo journey works end-to-end. Current seed flow leaves
  the Demo User in a role-gap state — pick one defensible default
  (`telecaller`? `helper`?) and document in seed comments.
- **(e)** Sale-complete endpoint (`POST /api/pos/sales`) requires
  `cashierGate` — already enforced; add a regression test pinning that a
  plain `USER` (no `wellnessRole`) gets 403 not 200.

### FR-3.3 Register / Shift onboarding (#826)

- **(a)** When an Owner / Admin / Manager opens POS on a tenant with **zero
  active Registers**, the page shows an **in-line setup wizard** (not the
  current "ask an admin" dead-end). The wizard:
  - Pre-selects the tenant's default Location (or asks which Location if
    multiple)
  - Pre-fills a sensible Register name (e.g. `"Main Register"` or
    `"<Location.name> Register"`)
  - Defaults opening float to `0`
  - Creates the Register via existing `POST /api/pos/registers`
  - Immediately opens a Shift via existing `POST /api/pos/shifts/open`
  - Transitions the same page into the cart UI (no full-page reload)
- **(b)** Cashier roles (doctor/professional/telecaller/helper) without a
  configured Register still see a useful message ("Ask an admin to set up
  POS" — same as today) but the message now links to a real admin contact
  surface, not an abstract instruction.
- **(c)** Tenant-level "POS module enabled" toggle in `Settings.jsx` for
  tenants who don't need POS. When `false`: sidebar entry hidden,
  `/wellness/pos` redirects to dashboard. Stored on `Tenant` (new column
  `posEnabled Boolean @default(false)` — gated migration with
  `[allow-add-column]` per the migration-safety check).
- **(d)** Register-configuration audit log — every `POST /api/pos/registers`
  call already emits `writeAudit('Register', 'create', ...)`. Confirm the
  audit row carries the wizard-vs-admin-page provenance (new field
  `metadata.source = 'pos-wizard' | 'admin-page'`) so post-incident review
  can tell which path the operator took.

### FR-3.4 Sale flow integrity (#830 follow-up)

- **(a)** Add-to-cart respects inventory availability for `PRODUCT` line
  items. Already enforced server-side in `POST /api/pos/sales` (atomic
  inventory decrement); add a UI-side pre-flight check so cashier can't add
  a sold-out item to the cart in the first place.
- **(b)** Payment-method selection mandatory before "Complete Sale" button
  enables. Frontend validation; server already enforces.
- **(c)** Receipt PDF generated post-sale via existing `pdfRenderer.js`.
  Auto-print integration (browser `window.print()`) on cashier confirmation.
- **(d)** Ledger entry created atomically with sale (existing — the
  `Sale.createdAt` + `SaleLineItem` rows commit in a single Prisma
  transaction with petty-cash impact computed at shift close).
- **(e)** Inventory decrement on sale (existing — atomic with sale create,
  reverses on refund).

### FR-3.5 Observability

- **(a)** Audit log captures every sale + every blocked sale-attempt (e.g.
  "shift closed", "insufficient inventory", "role denied"). Sale-complete
  already audits success; add audit emission for the failure branches.
- **(b)** Metrics surfaced on Owner Dashboard: sales-per-hour, avg-basket-size,
  per-register revenue, top-selling products (last 7 / 30 days). Endpoints
  partially exist (`GET /api/pos/sales` aggregations) — wire to dashboard.
- **(c)** Suspicious-pattern alerts: same cashier > N sales in M minutes,
  unusual refund rate, large-basket outlier. Heuristic — feeds the
  `AgentRecommendation` table (existing).

---

## 4. Non-functional Requirements

- POS page initial load **<2s** (operators expect counter-speed; lazy-load
  ancillary tabs)
- Sale-complete latency **<500ms** (or optimistic UI with async confirmation
  on slow networks)
- Offline tolerance: queue sales when offline + sync when reconnected
  (Phase 2 — see §7 Out of scope)
- Concurrent shifts: prevent same cashier opening 2 simultaneous shifts
  (existing — `routes/pos.js:298` enforces one OPEN shift per Register;
  extend to one OPEN shift per cashier across all Registers in a tenant)
- Per-vertical theme parity: POS page renders correctly under
  `[data-vertical="wellness"][data-theme="dark"]` (cross-references
  `PRD_DARK_MODE_CLUSTER.md`)

---

## 5. Hand-over Requirements / Design Decisions

### Design decisions (pending PM / Rishu sign-off)

- **DD-5.1** Routing fix shape: (i) permanent redirect `/pos` →
  `/wellness/pos` (keeps current URL canonical, no DB migration, two-tick
  redirect on first nav); OR (ii) drop the `/wellness/` prefix entirely and
  mount POS at `/pos` (cleaner URLs, but requires Sidebar + bookmarks +
  email-template links + any external integrations to update). **Recommend
  (i)** — less surface change, fixes the bug, leaves the door open for (ii)
  if the URL-prefix scheme is later overhauled across the wellness app.
- **DD-5.2** First-time onboarding: in-app wizard (FR-3.3 (a)) vs admin-only
  setup via the existing Cash Registers admin page? **Recommend in-app
  wizard** — Owner-as-highest-role hitting an "ask an admin" dead-end is the
  worst possible first-touch UX (the actual #826 bug). The wizard is
  one-shot and doesn't add ongoing complexity.
- **DD-5.3** "POS module enabled" toggle: per-tenant (FR-3.3 (c)) or
  per-vertical? **Recommend per-tenant** — wellness clinics that don't sell
  retail products still need POS-disabled to suppress the menu entry;
  vertical-level is too coarse.
- **DD-5.4** Role granularity: stay with the current 6-tier wellness role
  scheme (admin/manager/doctor/professional/telecaller/helper) and align
  the frontend RoleGuard with it; OR collapse to 2-tier (Owner-plus /
  Cashier)? **Recommend keep current 6-tier** — the granularity already
  exists everywhere else in wellness; collapsing for POS only would create
  drift.
- **DD-5.5** Offline mode scope: queue-and-sync (full offline support, IDB
  cache, conflict resolution); read-only-while-offline (no sales offline,
  show cached menu); or no-offline (online-only, show "offline" banner)?
  **Phase 1 recommend no-offline** with a clear offline-banner; queue-and-sync
  is a Phase 2 candidate that touches IDB + service-worker + conflict UI —
  big-scope, file its own PRD.

### Cred chase

None external — POS is an internal CRM feature. No vendor docs, no API keys,
no third-party SaaS integration in scope.

### Vendor docs

None.

---

## 6. Acceptance Criteria

- **AC-6.1** Owner navigates to `/pos` directly → POS screen renders (no 404). [#823]
- **AC-6.2** Owner navigates to `/wellness/pos` directly → POS screen renders. [#823]
- **AC-6.3** Sidebar "Point of Sale" click → POS renders on first click + every subsequent click across a 10-click sequence. [#824]
- **AC-6.4** Owner on a fresh tenant with zero Registers → in-line wizard creates default Register + opens Shift in a single screen transition. [#826]
- **AC-6.5** Demo User cashier role → completes a sale end-to-end (open shift → add cart line → select payment → complete → receipt). [#830]
- **AC-6.6** Plain USER role without `wellnessRole` → POS sidebar entry hidden + `/wellness/pos` direct URL returns RoleGuard message (not 404).
- **AC-6.7** Sale-complete audit log captures: cashier id, register id, shift id, sale id, total, payment method.
- **AC-6.8** Inventory decrements transactionally with sale; refund reverses atomically.
- **AC-6.9** Receipt PDF generated within 2s of sale-complete.
- **AC-6.10** Tenant admin toggles "POS module disabled" → sidebar entry disappears within one navigation cycle; direct URL redirects to dashboard.

---

## 7. Out of Scope

- **Multi-tenant POS chains** (cross-clinic basket / consolidated reporting across tenants)
- **Customer-facing self-service POS** (kiosk mode — Phase 2, separate PRD)
- **Subscription / recurring POS sales** (separate billing scope — already covered by `routes/subscriptions.js`)
- **POS-only mobile app** (Phase 2, separate PRD)
- **Offline mode** (queue-and-sync) — Phase 2 per DD-5.5
- **Hardware integration** (cash drawer trigger, receipt printer ESC/POS, barcode scanner USB) — Phase 2
- **Loyalty redemption UI in POS** (earning already wired via `maybeAutoCreditLoyaltyForSale`; redemption-at-checkout is separate scope)

---

## 8. Dependencies

- Existing POS route + Register / Shift / Sale / PettyCashLedger Prisma models (`schema.prisma:3752-3828`)
- Existing wellness-role middleware (`middleware/wellnessRole.js` — `verifyWellnessRole`)
- Existing audit log infrastructure (`writeAudit` + hash chain)
- Existing inventory module (transactional decrement on sale)
- Existing receipt PDF renderer (`services/pdfRenderer.js`)
- Existing loyalty hook (`maybeAutoCreditLoyaltyForSale`)
- Existing Cash Registers admin page (`frontend/src/pages/wellness/CashRegisters.jsx`)
- Sentry instrumentation (for FR-3.1 (d) router failed-match logging)

---

## 9. Open Questions

- **OQ-9.1** First-time POS setup: should it require Owner-level role, or can Admin / Manager configure the first Register? **Recommend Admin or higher** — Manager is a clinical role in wellness scheme, may not be the right operator-of-finances.
- **OQ-9.2** "Cashier" — does it exist as a distinct role today, or is the operational cashier always one of `doctor / professional / telecaller / helper`? Audit confirms the latter; consider adding `cashier` as a 7th wellness role for tenants where the front-desk staff is dedicated to POS only.
- **OQ-9.3** Multi-cashier per shift — Phase 1 supports one cashier per Shift (current model). Do any pilot tenants need a "handoff cashier mid-shift" workflow? If yes, file a follow-up PRD.
- **OQ-9.4** Offline-mode UX: should the offline banner show pending-sync count, or just an "offline" indicator? Hold for DD-5.5 phase-2 sign-off.
- **OQ-9.5** Receipt PDF auto-email to customer: do we want this on Phase 1, or is "print on cashier screen" sufficient? Recommend defer to Phase 1.5 — wire after the core hardening lands.
- **OQ-9.6** Demo User seed `wellnessRole` assignment — pick `telecaller` (front-desk default) or `helper` (broader)? Rishu's call.
- **OQ-9.7** "POS module enabled" tenant toggle default — `false` (opt-in) or `true` (opt-out, current behaviour)? Recommend `false` so a new tenant doesn't get a confusing dead-end menu entry.

---

## 10. Status Snapshot

- **Current state:** 4 OPEN POS bugs from the May 2026 Enhanced Wellness demo audit
- **This PRD:** WRITTEN 2026-05-23 (cron tick #27)
- **Path to remediation:** 5–10 engineering days (routing fix + RBAC alignment + onboarding wizard + sale-flow polish)
  - FR-3.1 routing: ~1 day (redirect mount + sidebar fix + Sentry hook + e2e spec)
  - FR-3.2 RBAC: ~1 day (frontend RoleGuard alignment + seed update + regression test)
  - FR-3.3 onboarding wizard: ~2–3 days (UI flow + tenant toggle + migration + audit metadata)
  - FR-3.4 sale flow polish: ~1 day (UI pre-flight + auto-print integration)
  - FR-3.5 observability: ~1 day (dashboard metrics wire-up + suspicious-pattern heuristic)
  - QA / hardening: ~1–2 days
- **Coordinates 4 GH issues:** #823 #824 #826 #830 — all OPEN as of 2026-05-23
- **Sibling PRDs (same coordinating-PRD shape):**
  - `PRD_TRAVEL_SECURITY_ARCHITECTURE.md`
  - `PRD_THEME_MANAGEMENT.md`
- **Cross-references:**
  - `PRD_DARK_MODE_CLUSTER.md` — POS page theme parity (NFR)
  - `prisma/seed-wellness.js` — Demo User role assignment update needed (FR-3.2 (d))
  - `backend/routes/pos.js` — receiver of FR-3.1 (e) route alias + FR-3.3 wizard endpoints (already exist)
  - `frontend/src/pages/wellness/PointOfSale.jsx` — receiver of FR-3.1 router instrumentation + FR-3.3 wizard UI

---

_Coordinates: #823, #824, #826, #830._

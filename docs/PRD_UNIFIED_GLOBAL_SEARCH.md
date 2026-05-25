# PRD — Unified Global Search

**Status:** DRAFT (written 2026-05-23, autonomous PRD-writer tick #30 / Agent 3)
**Source:** GH issue [#851](https://github.com/Globussoft-Technologies/globussoft-crm/issues/851) — `[Gap][US-001] Unified global search bar missing — no cross-entity header search`
**Priority:** P2 (high productivity uplift; not user-blocking)
**Sibling PRDs:** `PRD_WELLNESS_RBAC.md` (role-aware entity filtering), `PRD_TRAVEL_SECURITY_ARCHITECTURE.md` (PII payload concerns)

---

## §1 Background

Each module in the CRM has its own list filter (Patients filter, Leads filter, Vendors filter, Deals filter, Invoices filter, etc.) but there is no header-level search bar that searches across multiple entities at once. Operators who know "I'm looking for Sahil" must navigate to each module separately, apply that module's filter, and pivot.

Goal: a header-level search bar that returns mixed-entity results (Contact / Deal / Invoice / Patient / Trip / Lead / Ticket / Task / Project / Contract / Estimate / Email / KB-article) grouped by entity type, ranked by relevance, with keyboard-shortcut access (Cmd/Ctrl+K) and recent-search persistence.

### §1.1 Symptoms in the field

- New-user onboarding pain: "where do I look up John Doe?" requires knowing whether John is a Contact, a Lead, or a Patient.
- Cross-vertical pivot (Travel ↔ Wellness ↔ generic CRM): same human can be a Contact AND a Patient AND a Trip primary-contact; operator currently searches each module separately to assemble a 360° view.
- Loss of cross-entity discovery: "show me everything for phone +91-9811000001" is a multi-page workflow today, not a single search.

### §1.2 Existing infrastructure (DO NOT rebuild)

| Asset | Path | Status / Gap |
|-------|------|--------------|
| Search backend route | `backend/routes/search.js` (65 LOC) | EXISTS. Returns 10 entity types (Contact, Deal, Invoice, Ticket, Task, Project, Contract, Estimate, EmailMessage, KbArticle). Tenant-scoped. **Gaps:** no Patient / Trip / Itinerary, no ranking, no role-aware filter, no audit log, no recent-search cache. |
| CommandPalette (Cmd+K palette) | `frontend/src/components/CommandPalette.jsx` (159 LOC) | EXISTS. Listens for Cmd/Ctrl+K, renders modal. **Gap:** fetches `/api/deals` and `/api/contacts` as full lists then filters CLIENT-side — broken at scale (only newest-N window matches, mirrors the v3.4.x dashboard-aggregation antipattern). |
| Omnibar (broader command surface) | `frontend/src/components/Omnibar.jsx` (131 LOC) | EXISTS. Cmd+K toggle, calls server-side `/api/search?q=` with 300ms debounce (`SEARCH_DEBOUNCE_MS`). Shows Contacts / Deals / Invoices only. **Gap:** narrow entity set, no header-bar surface (modal-only). |
| Per-module filter UIs | `frontend/src/pages/*.jsx` (50+ pages) | EXISTS — keep as-is for module-local power-filter. |
| Audit log infra | `prisma.auditLog.create()` + `routes/audit.js` | EXISTS. Extend with `action: 'search.query'` rows for PII access trail. |
| Tenant scoping middleware | `req.user.tenantId` via `verifyToken` | EXISTS — already enforced on every `findMany`. |
| Role middleware | `verifyRole(['ADMIN'])` + wellness-role gates | EXISTS — extend for per-role entity-type visibility. |
| Phone normalization helper | `backend/utils/deduplication.js` | EXISTS — reuse for phone-equality matching in search. |

**Implication for impl:** this PRD is mostly extension work on existing infrastructure, NOT greenfield. The header surface is the largest new piece; backend extensions are additive to `routes/search.js`.

---

## §2 Use cases

| UC | Persona | Scenario |
|----|---------|----------|
| UC-2.1 | Operator (generic CRM) | Types `Sahil` in header search → dropdown shows 3 contacts named Sahil + 2 leads + 1 deal, grouped by entity type, ranked by exact-match-first then recency |
| UC-2.2 | Finance | Types invoice number `INV-2026-0142` → invoice detail row surfaces FIRST (exact-prefix match wins) |
| UC-2.3 | Telecaller | Types phone `+91-9811000001` → matching Contact + linked Deal + linked Patient (cross-vertical 360° in one query) |
| UC-2.4 | Sales | Types deal name `Umrah package 2026` → deal rows matching the keywords, ranked by deal-stage (active before closed) |
| UC-2.5 | Marketing | Types email partial `@example.com` → contacts with that email domain |
| UC-2.6 | Power user | Hits `Cmd+K` → CommandPalette opens (separate navigation surface, distinct from header search) |
| UC-2.7 | Any operator | Types from any page → search jumps to result detail page on `Enter` (or arrow + Enter to pick) |
| UC-2.8 | Doctor (wellness) | Types patient name → ONLY own-assigned patients in results (role-aware filter), even if other patients exist for that name in tenant |

---

## §3 Functional requirements

### FR-3.1 Search surface

- **(a)** Header search bar always visible in `Layout.jsx` top-bar (sits between logo and notification bell)
- **(b)** Placeholder text: `Search contacts, deals, leads, invoices…` (i18n-scoped per locale)
- **(c)** Search results render in dropdown panel anchored to the search input, grouped by entity type with entity-badge icons
- **(d)** Keyboard shortcut: `Cmd+K` (Mac) / `Ctrl+K` (Win/Linux) OR `/` to focus header search input (currently `Cmd+K` opens CommandPalette modal — RECONCILE: header search and CommandPalette can share the shortcut OR split via Cmd+K vs Cmd+/, design decision DD-5.1)
- **(e)** Search persists across page navigation via debounce + recent-searches cache
- **(f)** Mobile: search bar collapses to icon → expand on tap

### FR-3.2 Search target entities (per entity, list searchable fields)

| Entity | Fields | Vertical | Already in `routes/search.js`? |
|--------|--------|----------|--------------------------------|
| Contact | name, email, phone, company, GSTIN | All | ✅ |
| Lead | name, email, phone, status | All | ❌ ADD |
| Deal | title, customer-name (joined), amount | All | ✅ |
| Invoice | invoiceNum, customer-name (joined), amount | All | ✅ |
| Ticket | subject, description, status | All | ✅ |
| Task | title, status, priority | All | ✅ |
| Project | name, status | All | ✅ |
| Contract | title, status | All | ✅ |
| Estimate | title, estimateNum, status | All | ✅ |
| EmailMessage | subject, from, to | All | ✅ |
| KbArticle | title, content (truncated snippet), slug | All | ✅ |
| **Patient** | name, phone, email, MRN | Wellness | ❌ ADD (role-aware filter mandatory) |
| **Trip / TmcTrip** | tripName, destination, primary-contact-name (joined) | Travel | ❌ ADD |
| **Itinerary** | title, destination, customer-name | Travel | ❌ ADD |
| **VisaApplication** | applicantName, passportNum, destinationCountry | Travel (Visa Sure sub-brand) | ❌ ADD |
| **Booking** | bookingNum, customer-name, status | Wellness + Travel | ❌ ADD (optional Phase 1.5) |

### FR-3.3 Ranking + relevance

- **(a)** Exact-match wins (e.g. phone-digits-equality, exact-prefix on invoiceNum, exact-string on email)
- **(b)** Prefix-match before substring-match
- **(c)** Recency: records with newer `updatedAt` ranked higher (recency-weight tunable, default `0.3`)
- **(d)** Active-status before closed-status (e.g. open Deal before closed-won/closed-lost Deal)
- **(e)** Per-entity-type internal ranking (top-5 per entity); cross-entity ordering by relevance-score in the dropdown sections
- **(f)** Phone matching uses normalized digits-only equality (reuse `backend/utils/deduplication.js#normalizePhone`)

### FR-3.4 Search infrastructure (backend)

- **(a)** Endpoint `GET /api/search?q=<query>&entityTypes=<csv>&limit=<n>` — extend existing `backend/routes/search.js`
- **(b)** Response shape (additive — preserves existing top-level entity-keyed shape per back-compat standing rule):
  ```json
  {
    "contacts": [...], "deals": [...], ..., "totalResults": 42,
    "results": [
      { "entityType": "contact", "id": 123, "label": "Sahil Verma", "snippet": "+91-9811000001 • Mumbai", "url": "/contacts/123", "score": 0.95, "matchedField": "phone" },
      { "entityType": "patient", "id": 47,  "label": "Sahil Verma", "snippet": "MRN-0047 • last visit 2026-05-10", "url": "/wellness/patients/47", "score": 0.88, "matchedField": "name" }
    ],
    "queryTimeMs": 142
  }
  ```
- **(c)** Per-entity-type Prisma queries run in `Promise.all` (existing pattern), merged + scored in-process, top-N returned
- **(d)** Tenant scoping enforced server-side (every `findMany` filtered by `tenantId: req.user.tenantId` — existing pattern)
- **(e)** Role-aware filter: Doctor sees `patient.assignedDoctorId === req.user.id`; Cashier sees no Patient PHI; ADMIN sees all in-tenant
- **(f)** Audit log entry per search: `prisma.auditLog.create({ data: { tenantId, userId, action: 'search.query', payload: { q, entityTypes, resultCount } } })` — query string + result count logged, NOT result content

### FR-3.5 Performance

- **(a)** Search latency: <500ms P95 for top-10 results across 10+ entity types (issue #851 asks <200ms p95 — set as Phase 2 target after Phase 1 Path A measures actual P95)
- **(b)** Cache: per-tenant recent-search-cache in Redis if available (fall back to in-process LRU); 5-min TTL
- **(c)** Debounce: 200-300ms client-side (currently `SEARCH_DEBOUNCE_MS = 300` — keep)
- **(d)** Pagination: top-10 returned eagerly; `?limit=50` for "see all"; "See all in Contacts" link deep-links to `/contacts?q=<query>` per-module filter (existing)
- **(e)** Index strategy (DD-5.2): start with `LIKE`/`contains` via Prisma; promote to Postgres `pg_trgm` / `ts_vector` OR Meilisearch / OpenSearch once P95 exceeds 500ms

### FR-3.6 RBAC integration

- **(a)** Per-role entity-type visibility — mapping table seeded in `backend/lib/searchPermissions.js`:
  - ADMIN: all entity types
  - MANAGER: all entity types in own scope
  - USER: Contacts, Leads, Deals, Tasks (no Invoice, no Contract, no Patient)
  - DOCTOR (wellness): own-assigned Patients only; no Deals/Contracts
  - PROFESSIONAL (wellness): assigned-locations' Patients only
  - TELECALLER (wellness): Leads + Patients (queue-assigned)
  - CASHIER (wellness): Invoices + Payments only, NO Patient PHI
- **(b)** Cross-tenant searches return 0 results silently (no enumeration leak)
- **(c)** Audit log every search (operator + query + result-count, NOT result content)
- **(d)** Field-level masking: sensitive fields (e.g. patient.aadhaar, patient.pan) NEVER returned in snippets

### FR-3.7 Frontend surface

- **(a)** New `<GlobalSearch />` component mounted in `frontend/src/components/Layout.jsx` top-bar
- **(b)** Reuse `SEARCH_DEBOUNCE_MS` constant from `frontend/src/utils/timing.js`
- **(c)** Result-row rendering: entity-badge icon (lucide-react) + label + snippet + URL → click navigates via `useNavigate`
- **(d)** Empty-query state: render recent-searches list (localStorage, last 10 queries, per-user)
- **(e)** Pinned shortcuts (per #851 "Recent searches and pinned shortcuts"): user can pin frequent searches via right-click → "Pin to recent" — Phase 2
- **(f)** Reconcile with CommandPalette + Omnibar: clarify which surface handles what (DD-5.1)

---

## §4 Non-functional requirements

- **Mobile-friendly:** search collapses to icon ≤768px viewport; expanded view fills 80% of viewport-width
- **Accessibility:** keyboard navigation (Tab through results, Enter to select), screen-reader-friendly `aria-label` on input + `role="listbox"` on results dropdown, focus-trap when dropdown open
- **i18n:** placeholder + group-headers per locale (en-US / en-IN / hi-IN / ar-SA for RFU sub-brand)
- **Backward-compat:** existing `/api/search` response shape (top-level entity-keyed: `body.contacts`, `body.deals`, etc.) preserved; new `body.results[]` array is ADDITIVE per the API-shape-change standing rule
- **Observability:** every search logs `queryTimeMs` to Sentry breadcrumb + structured log; P95 dashboard surfaced in `/api/admin/search-perf` (Phase 2)

---

## §5 Hand-over / cred chase / design decisions

### Design decisions (block backend impl)

| ID | Decision | Owner | Default if no answer |
|----|----------|-------|---------------------|
| DD-5.1 | Shortcut conflict: `Cmd+K` currently opens CommandPalette modal. Should header search take Cmd+K and CommandPalette move to Cmd+/, OR keep Cmd+K for palette and use `/` for header search? | Product (Rishu / Suresh) | Header search = `/`; CommandPalette stays on Cmd+K |
| DD-5.2 | Backend search strategy Phase 1: per-entity Prisma `contains` queries (simple, slower, current pattern) vs Postgres `pg_trgm` extension (medium effort, fuzzy + faster) vs full-text engine (Meilisearch / OpenSearch — fast, infra-heavy)? | Suresh (TA) | Start with Prisma `contains`, promote to `pg_trgm` once P95 > 500ms |
| DD-5.3 | Cross-vertical scope: in wellness-vertical tenant, does header search show Contacts (generic) AND Patients, OR only Patients (vertical-scoped)? Same question for travel-vertical. | Product | Show all entity types user has role-permission for, with vertical-specific entities appearing first |
| DD-5.4 | Recent-search cache: per-tenant + per-user (privacy-safer) OR per-user only (smaller storage)? | Product | per-user only |
| DD-5.5 | Result-click action: deep-link to record-detail page (current direction) OR side-panel preview before navigation? | Product | deep-link first; side-panel Phase 2 |
| DD-5.6 | Ranking: rule-based (hand-tuned weights per FR-3.3) OR learning-to-rank (LightGBM + click-data)? | Suresh | rule-based; LTR Phase 3 |

### Cred chase

- None external (in-house feature)
- IF DD-5.2 chooses Meilisearch / OpenSearch: needs infra spec from Suresh (single-node ok? where hosted? backup?)

### Vendor docs (if needed)

- Postgres `pg_trgm`: <https://www.postgresql.org/docs/current/pgtrgm.html>
- Meilisearch: <https://www.meilisearch.com/docs>
- OpenSearch: <https://opensearch.org/docs/latest/>

---

## §6 Acceptance criteria

- **AC-6.1** Operator types `Sahil` in header search → top-10 results returned <500ms P95, grouped by entity type, ranked exact-match-first then by recency
- **AC-6.2** Operator types phone `+91-9811000001` → matching Contact surfaces FIRST in results (exact-digit-match wins; phone normalization applied)
- **AC-6.3** `Cmd+K` opens the header-search-bar focus (per DD-5.1; updates if decision differs)
- **AC-6.4** Doctor role searching for patient name → results contain ONLY patients with `assignedDoctorId === req.user.id`; other in-tenant patients NOT returned
- **AC-6.5** Cross-tenant query (forged `tenantId` in URL) → 0 results, no enumeration leak; audit log entry created
- **AC-6.6** Empty query → recent-searches list rendered (top 10 from per-user localStorage)
- **AC-6.7** Result click → `useNavigate` deep-links to record detail page (e.g. `/contacts/123`, `/wellness/patients/47`)
- **AC-6.8** Cashier role search returns Invoices + Payments only; Patient row entirely absent
- **AC-6.9** Audit log row created per search with shape `{ action: 'search.query', payload: { q, entityTypes, resultCount } }`; result CONTENT not logged
- **AC-6.10** Response shape: `body.contacts[]`, `body.deals[]`, etc. preserved (back-compat with existing Omnibar); new `body.results[]` array additive

---

## §7 Out of scope (Phase 2+)

- **Saved searches** (named saved search queries) — Phase 2
- **AI-suggested search expansions** ("did you mean…", semantic expansion via Gemini) — Phase 2
- **Search-within-document** (PDF / attachment full-text indexing) — separate scope
- **Voice search** (mic input → STT → query) — Phase 3
- **Cross-record relationship search** ("all artifacts for John Doe" — show every entity referencing John) — Phase 2
- **Searchable soft-deleted records** with admin toggle — Phase 2 (OQ-9.5)

---

## §8 Dependencies

| Dep | Source | Why |
|-----|--------|-----|
| CommandPalette.jsx | EXISTS | Reuse modal pattern + Cmd+K listener convention |
| Omnibar.jsx | EXISTS | Reuse `/api/search` integration + SEARCH_DEBOUNCE_MS |
| backend/routes/search.js | EXISTS | Extend with Patient/Trip/Itinerary/VisaApplication + ranking + audit log |
| `Layout.jsx` top-bar | EXISTS | Mount point for `<GlobalSearch />` component |
| Tenant scoping middleware | EXISTS (`verifyToken`) | `req.user.tenantId` already enforced |
| Role middleware | EXISTS (`verifyRole`, `phiReadGate`) | Per-role entity-type visibility (FR-3.6) |
| Audit log | EXISTS (`prisma.auditLog`) | search.query rows for PII access trail |
| Phone normalization | EXISTS (`backend/utils/deduplication.js#normalizePhone`) | Digit-equality matching (FR-3.3.f) |
| `SEARCH_DEBOUNCE_MS` constant | EXISTS (`frontend/src/utils/timing.js`) | Client-side debounce (FR-3.5.c) |
| **Sibling PRDs** | | |
| `PRD_WELLNESS_RBAC.md` | DRAFT | Role-aware entity filter mapping (FR-3.6) shared with this PRD |
| `PRD_TRAVEL_SECURITY_ARCHITECTURE.md` | DRAFT | PII payload masking convention for cross-vertical search snippets |

---

## §9 Open questions

- **OQ-9.1** Should the dropdown offer entity-type filters (e.g. "Contact only / Lead only / All")? Per #851 hint: "grouped results with See all in X" — implies groups but not filter-pills. Default: no filter pills in Phase 1; add per-group "See all in Contacts" link to existing module list with pre-applied filter
- **OQ-9.2** Per-tenant search-result-limit (free-tier 10 results vs pro-tier 50 results)? Tier-gating not currently elsewhere in CRM — defer until tiered pricing lands
- **OQ-9.3** Search history retention period — privacy concern. Default 90 days, configurable per-tenant? Aligns with retention engine (`retentionEngine.js`)
- **OQ-9.4** Multi-language indexing: should we index multiple-language fields (e.g. Arabic names for RFU Umrah sub-brand stored alongside English transliteration)? Phase 1 = English only; Phase 2 = locale-aware indexing
- **OQ-9.5** Soft-deleted records: hidden by default but searchable via admin toggle `?includeArchived=1`? Aligns with existing soft-delete patterns
- **OQ-9.6** Telephony-paste convenience: if a phone is pasted with formatting (`+91 98110 00001`), normalize before query?  Default yes (reuse `normalizePhone`)
- **OQ-9.7** Should "exact email match" auto-navigate (skip dropdown, go straight to contact)? Power-user feature; default NO (always show dropdown so user can confirm)
- **OQ-9.8** Multi-tenant ADMIN (the Globussoft superuser tier) — does header search span tenants for impersonation flows? Default NO (always tenant-scoped); cross-tenant lookup is a separate admin tool

---

## §10 Status snapshot

| Date | State |
|------|-------|
| 2026-05-23 | PRD written this tick (autonomous cron tick #30 / Agent 3) |
| Backend route | EXISTS at `backend/routes/search.js` (65 LOC, 10 entity types). Extensions: ranking + Patient/Trip/Itinerary/VisaApplication + audit log + role filter |
| CommandPalette | EXISTS (159 LOC). **Bug to fix:** client-side filtering of full lists (newest-N window only) — replace with `/api/search` integration |
| Omnibar | EXISTS (131 LOC). Works server-side but limited to Contacts / Deals / Invoices. Either retire (header GlobalSearch supersedes) or repurpose to power-user palette |
| Header GlobalSearch component | TO BUILD (new `frontend/src/components/GlobalSearch.jsx`, mounted in `Layout.jsx`) |
| Audit log surface | EXISTS — add `action: 'search.query'` rows |
| **Path to implementation** | 10-20 engineering days (depends on DD-5.2 backend choice — Prisma-extend path ~10 days, full-text engine path ~20+ days) |
| **Blocks** | DD-5.1 (Cmd+K conflict reconciliation) and DD-5.2 (backend index strategy) needed BEFORE engineering pickup |

---

## Refs

- GH Issue: [#851](https://github.com/Globussoft-Technologies/globussoft-crm/issues/851)
- Sibling PRDs: `docs/PRD_WELLNESS_RBAC.md`, `docs/PRD_TRAVEL_SECURITY_ARCHITECTURE.md`
- Existing code: `backend/routes/search.js`, `frontend/src/components/CommandPalette.jsx`, `frontend/src/components/Omnibar.jsx`, `frontend/src/utils/timing.js#SEARCH_DEBOUNCE_MS`
- Standing-rule reference: "Client-side aggregation over a paginated endpoint is a structural correctness bug" (CLAUDE.md) — CommandPalette's client-side filtering of `/api/deals` and `/api/contacts` is an instance of this bug class

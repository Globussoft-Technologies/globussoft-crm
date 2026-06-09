# Travel CRM — big-scope backlog (active build)

**Active from 2026-06-09.** Successor to the closed [TRAVEL_CODEABLE_BACKLOG.md](TRAVEL_CODEABLE_BACKLOG.md) (9/9 shipped). Targets the 4 multi-day big-scope features identified in [TRAVEL_CRM_PENDING_FEATURES.md](TRAVEL_CRM_PENDING_FEATURES.md).

> **Markers:** ⬜ TODO · 🟡 IN-PROGRESS · ✅ DONE · 🔵 BLOCKED

**Honest scope:** of the 4 big-scope features, ~25-36 eng-days are codeable today; the rest gate on product calls, creds, or counsel. Cron will skip 🔵 rows and dispatch ⬜ rows whose deps are ✅.

## Block 1 — Travel Security architecture

Per [PRD_TRAVEL_SECURITY_ARCHITECTURE.md](PRD_TRAVEL_SECURITY_ARCHITECTURE.md). 5 of 7 FRs are codeable today; FR-3.1 (auth migration) and FR-3.3 (opaque IDs) are blocked on architectural DDs.

| # | Slice | Files | Marker | Cost | Notes |
|---|---|---|---|---|---|
| **S1** | FR-3.2 — CSP nonces + remove `'unsafe-inline'` | `backend/middleware/security.js` (extend) + `backend/lib/cspNonce.js` (NEW) + `frontend/index.html` (template change for nonce injection) + tests | ✅ DONE 2026-06-09 — `02c71f7e` | ~3d | Replace `'unsafe-inline'` in script-src + style-src with per-request nonces. Backend mints nonce per request → injected into HTML via meta tag → vite-build-time CSS gets nonce attr. Closes #917. Backward-compat: report-only mode first via FR-3.7. Deploy-layer follow-up: Nginx (or Express static handler) must substitute `__CSP_NONCE__` placeholder in served index.html with the live `res.locals.cspNonce` per response and stamp the matching nonce onto every `<script>`/`<style>` tag. |
| **S2** | FR-3.4 — Tenant-scope audit across 102 routes + ESLint rule | `backend/eslint.config.js` (extend) + `e2e/tests/cross-tenant-coverage-audit.spec.js` (NEW) + audit doc | ⬜ TODO | ~4d | ESLint rule warns when a Prisma call inside `routes/**/*.js` is missing `tenantId` in WHERE. Cron-callsite review separately. E2E spec verifies every route under `/api/*` is tenant-scoped via cross-tenant probe. Closes #918 + #919. |
| **S3** | FR-3.5 — PII list-endpoint summary projections | `backend/lib/listProjection.js` (NEW) + 8-12 route extensions for list endpoints (contacts/leads/patients/trip participants/etc.) + tests | ⬜ TODO | ~3d | List endpoints today return full row shape including PII. New helper auto-applies `select { id, name, ...summaryFields }` projection on list endpoints; detail endpoint returns full shape. Reduces PII exposure surface. Closes #920. |
| **S4** | FR-3.6 — iframe-isolation + SRI build step | `frontend/vite.config.js` (extend with SRI plugin) + `backend/middleware/security.js` (CSP frame-ancestors) + tests | ⬜ TODO | ~3d | SRI hashes on vendor chunks; X-Frame-Options + CSP frame-ancestors deny by default; per-tenant iframe allowlist. Closes #921. |
| **S5** | FR-3.7 — CSP-report endpoint + cross-tenant interceptor | `backend/routes/security_reports.js` (NEW) + `backend/middleware/crossTenantInterceptor.js` (NEW) + tests | ✅ DONE 2026-06-09 — `ec3c25e5` | ~2d | POST `/api/security/csp-report` collects violation reports; saves to `SecurityIncident` model (additive). Cross-tenant interceptor is request-time defense: if route's tenant-where filter would fan out, intercept before DB. Closes #921. |
| **S6** | 🔵 BLOCKED — FR-3.1 auth migration (JWT → httpOnly cookie + csurf + AuthContext refactor + per-tenant flag) | `backend/middleware/auth.js` (replace) + `frontend/src/App.jsx` (AuthContext refactor) + many | 🔵 BLOCKED | ~5d | **Blocked on:** DD-5.1 (cookie shape decision — same-site=strict vs lax; refresh-token rotation policy), DD-5.5 (rollout cadence — flag-gated per tenant or big-bang). Critical-path before any production client. |
| **S7** | 🔵 BLOCKED — FR-3.3 sequential IDs → opaque IDs (`publicId` column on 14+ models + dual-route + backfill) | `backend/prisma/schema.prisma` (publicId on 14 models, requires bless marker — UNIQUE on backfilled column) + dual-route middleware + per-route Prisma extensions | 🔵 BLOCKED | ~6d | **Blocked on:** DD-5.2 (id-migration shape — nanoid vs UUIDv7 vs hashids; column name; index strategy). Once decided, runs as 14+ parallel sub-slices. |

## Block 2 — Itinerary visual editor

Per [PRD_TRAVEL_ITINERARY_UPGRADES.md](PRD_TRAVEL_ITINERARY_UPGRADES.md). Most sub-features are codeable; Mapbox + Gemini cred items have stub-mode fallbacks per PRD §Q-IT-1/Q-IT-2.

| # | Slice | Files | Marker | Cost | Notes |
|---|---|---|---|---|---|
| **S8** | Add `dayNumber` + `latitude` + `longitude` columns on ItineraryItem | `backend/prisma/schema.prisma` (additive nullable, no bless marker) + migration safety | ⬜ TODO | ~½d | Pure schema add. Used by S9 (visual editor) + S11 (map preview). |
| **S9** | Day-by-day visual itinerary editor (drag-drop reorder + add/remove day groups) | `frontend/src/pages/travel/ItineraryDayEditor.jsx` (NEW) + `frontend/src/__tests__/ItineraryDayEditor.test.jsx` + App.jsx route + backend support for batch-update `dayNumber` | ⬜ TODO | ~5d | Per FR-3.3. Drag-drop across days, intra-day reorder. Uses the same touch-event pattern from C4 (Pipeline.jsx). Posts batch updates `PATCH /api/travel/itineraries/:id/items/reorder` with `[{itemId, dayNumber, sortOrder}]`. Depends on S8 (schema). |
| **S10** | Leaflet+OSM map provider integration + lightweight Geocoder | `frontend/src/components/MapPreview.jsx` (NEW) + `frontend/src/lib/geocoder.js` (NEW, OSM Nominatim wrapper with rate limiting + cache) | ⬜ TODO | ~2d | Per FR-3.4. No API key needed — uses public OSM tile servers (with attribution). Component renders pins for ItineraryItems with lat/lng. Cached geocoder hits Nominatim with `User-Agent` header. Depends on S8 (lat/lng columns). |
| **S11** | OpenTripMap POI seed import (~500 POIs across India + Saudi + Europe destinations) | `backend/scripts/seedOpenTripMapPois.js` (NEW) + `backend/prisma/seed-travel-pois.js` (NEW) + sample fixture | ⬜ TODO | ~1d | Per FR-3.5. Free API key (Yasin needs to sign up at opentripmap.io — ~5 min self-serve, NOT a "wait on Yasin" blocker; agent can use placeholder env var). Top 50 POIs per top-10 destinations. Idempotent upsert. |
| **S12** | Inline Add-POI modal with `pendingApproval` queue | `frontend/src/pages/travel/PoiPendingApprovalQueue.jsx` (NEW) + `backend/routes/travel_pois.js` (extend with approve/reject) + tests | ⬜ TODO | ~2d | Per FR-3.7. Reps suggest a new POI inline; lands in approval queue; ADMIN approves/rejects. Depends on S11 (POI model). |
| **S13** | Brand-kit-aware itinerary template defaults from `subBrandConfigJson` | `backend/routes/travel_itinerary_templates.js` (extend creation to apply brand-kit defaults) + tests | ⬜ TODO | ~1d | Per FR-3.8. Reads `Tenant.subBrandConfigJson` and seeds default cover-image colors / fonts. Q22 (brand pack) is content-blocker for actual assets — config-driven defaults are codeable now. |
| **S14** | LLM `itinerary-suggest` task class (stub-mode) | `backend/services/itinerarySuggestLLM.js` (NEW) + register in `backend/lib/llmRouter.js` + tests | ⬜ TODO | ~3d | Per FR-3.6. Reuses tmcDiagnosticPrompts pattern. Stub returns canned suggestion. Real-mode swap blocked on Q-IT-2 (overlaps Q11 — Gemini key). Pure module shipping is fine. |

## Block 3 — Marketing Flyer canvas editor

Per [PRD_TRAVEL_MARKETING_FLYER.md](PRD_TRAVEL_MARKETING_FLYER.md). DD-5.1 (Polotno vs in-house) gates the canvas editor itself; everything around it can ship.

| # | Slice | Files | Marker | Cost | Notes |
|---|---|---|---|---|---|
| **S15** | AI copy task class `marketing-flyer-copy` (stub-mode) | `backend/services/marketingFlyerCopyLLM.js` (NEW) + register in `lib/llmRouter.js` + tests | ⬜ TODO | ~1d | Per FR-3.6.1. Stub returns canned headline + body + CTA per destination. Real-mode swap blocked on Q-AI-3 (Gemini key, overlaps Q-IT-2). |
| **S16** | AI image task class `marketing-flyer-image` (stub-mode) | `backend/services/marketingFlyerImageLLM.js` (NEW) + register in `lib/llmRouter.js` + tests | ⬜ TODO | ~1d | Per FR-3.6.3. Stub returns a placeholder image URL. Real-mode swap blocked on Q-MF-2 (AI image API key). |
| **S17** | PDF + multi-aspect PNG render via headless Chromium (Puppeteer) | `backend/services/flyerRenderEngine.js` (NEW) + `backend/routes/travel_flyer_templates.js` (extend with `POST /:id/render`) + tests | ⬜ TODO | ~3d | Per FR-3.4. Takes a flyer template + data → renders PDF (A4 + A5) + PNGs (1200×1200 square, 1080×1920 portrait IG, 1920×1080 landscape FB). Uses existing pdfRenderer pattern + adds Puppeteer for PNG path. |
| **S18** | Public share URL + embed code for flyers | `backend/routes/travel_flyer_public.js` (NEW) + `frontend/src/pages/public/FlyerView.jsx` (NEW) + tests | ⬜ TODO | ~2d | Per FR-3.5.3/4. Mirrors C9 (Quote Accept Landing) — JWT-share token → public read-only flyer view + embed iframe snippet. Depends on S17 (need rendered output to serve). |
| **S19** | SequenceStep.attachmentRefs flyer kind extension | `backend/prisma/schema.prisma` (extend SequenceStep additive) + `backend/cron/sequenceEngine.js` (handle flyer attachment when sending) + tests | ⬜ TODO | ~1d | Per FR-3.5/AC-6.5. Existing Sequence engine handles file attachments; extend to handle `attachmentKind: 'flyer'` with flyer ID reference → render-on-send. Depends on S17. |
| **S20** | 🔵 BLOCKED — Canvas editor (DD-5.1 — Polotno embed vs in-house) | `frontend/src/pages/travel/FlyerCanvasEditor.jsx` (NEW) + many | 🔵 BLOCKED | ~5-10d depending on choice | **Blocked on:** DD-5.1 product call. Polotno embed = ~5d (license cost). In-house = ~10d (more flex, no license). |
| **S21** | 🔵 BLOCKED — Asset library + multer pipeline + tag search | `backend/routes/travel_flyer_assets.js` (NEW) + Multer S3/Cloudinary uploader + frontend modal | 🔵 BLOCKED | ~3d | **Blocked on:** Q-MF-1 (storage cred — S3 vs Cloudinary credentials). |
| **S22** | 🔵 BLOCKED — WhatsApp share flow | `backend/services/flyerWhatsAppShare.js` (NEW) | 🔵 BLOCKED | ~1d | **Blocked on:** Q9 (Wati WhatsApp Business creds — overlaps with broader 7-cron WA stubs). |

## Block 4 — B2B Agent Portal

Per [PRD_TRAVEL_B2B_AGENT_PORTAL.md](PRD_TRAVEL_B2B_AGENT_PORTAL.md). Entire PRD is BLOCKED on 7 design decisions that gate impl topology. **No agent can dispatch on these until the DDs are resolved.** Listed here for transparency.

| # | Slice | Marker | Why blocked |
|---|---|---|---|
| **S23** | 🔵 SubAgent model + auth + dashboard | 🔵 BLOCKED | DD-5.1 (new app vs route prefix) |
| **S24** | 🔵 Commission ledger + accrual + monthly statement + TDS | 🔵 BLOCKED | DD-5.5 (approval chain shape) |
| **S25** | 🔵 Markup / clone-with-margin for sub-agents | 🔵 BLOCKED | DD-5.4 (policy editor surface) |
| **S26** | 🔵 CorporateAccount + multi-traveler booking | 🔵 BLOCKED | DD-5.5 |
| **S27** | 🔵 Travel-policy validator + approval workflow | 🔵 BLOCKED | DD-5.4 + DD-5.5 |
| **S28** | 🔵 Expense reporting + CSV/JSON/PDF exports | 🔵 BLOCKED | DD-5.5 |
| **S29** | 🔵 Per-sub-brand theming + AGENT RBAC extension | 🔵 BLOCKED | DD-5.1 |

## Block 5 — Smaller per-PRD residuals (codeable today)

| # | Slice | Files | Marker | Cost | Notes |
|---|---|---|---|---|---|
| **S30** | Quote → Invoice convert flow | `backend/routes/travel_quotes.js` (extend with `POST /:id/convert-to-invoice`) + `backend/lib/quoteToInvoiceConverter.js` (NEW) + tests | ⬜ TODO | ~2d | Per [PRD_TRAVEL_QUOTE_BUILDER](PRD_TRAVEL_QUOTE_BUILDER.md). `TravelInvoice.quoteId` FK already exists. Copy lines + amounts to invoice, status: `pending_payment`. Idempotent — re-convert returns existing invoice. |
| **S31** | `QuoteTemplate` model + admin page + CRUD route | `backend/prisma/schema.prisma` (additive `TravelQuoteTemplate` model) + `backend/routes/travel_quote_templates.js` (NEW) + `frontend/src/pages/travel/QuoteTemplates.jsx` (NEW) + tests | ⬜ TODO | ~2d | Per [PRD_TRAVEL_QUOTE_BUILDER](PRD_TRAVEL_QUOTE_BUILDER.md). Template = pre-filled QuoteLine set for common itineraries (Umrah-7d / Golden-Triangle-5d / etc.). Apply to new quote. |
| **S32** | FX-rate locking at accept-time | `backend/routes/travel_quotes_public.js` (extend accept handler to snapshot FX rate) + tests | ⬜ TODO | ~1d | Per [PRD_TRAVEL_QUOTE_BUILDER](PRD_TRAVEL_QUOTE_BUILDER.md). On accept, capture FX rate to a snapshot field on TravelQuote. Prevents margin shift between quote send + customer accept. |
| **S33** | CancellationPolicy model + CR-NOTE issuance flow | `backend/prisma/schema.prisma` (CancellationPolicy + CreditNote shapes) + `backend/routes/travel_invoices.js` (extend with CR-NOTE issuance) + tests | ⬜ TODO | ~3d | Per [PRD_TRAVEL_BILLING](PRD_TRAVEL_BILLING.md). When invoice marked `cancelled`, auto-create credit-note row per policy table (full-refund < N days, 50% refund N-M days, no-refund < M days). Parent-child credit-note FK already exists. |
| **S34** | Per-sub-brand PDF invoice templates | `backend/services/pdfRenderer.js` (extend `renderInvoice()` with sub-brand-aware template selection) + tests | ⬜ TODO | ~2d | Per [PRD_TRAVEL_BILLING](PRD_TRAVEL_BILLING.md). Reads `Tenant.subBrandConfigJson` + `BrandKit` for logo/colors/fonts. Q22 blocker is content (actual brand assets); template-selection logic ships now. |

## Dispatch DAG

```
S1 / S2 / S3 / S4 / S5 ── parallel — all codeable today (Travel Security)
S8 ──> S9 + S10 ──> S11 ──> S12 (Itinerary editor chain)
S13 / S14 — parallel (Itinerary)
S15 / S16 / S17 ── parallel — S18 + S19 depend on S17 (Marketing Flyer)
S30 / S31 / S32 / S33 / S34 — parallel (per-PRD residuals)
```

**Codeable-now count:** 22 rows (S1-S5, S8-S19 (less the BLOCKED ones), S30-S34). Estimated total: ~50-65 engineering days. With 3 parallel agents per tick, ~10-15 wall-clock days.

**🔵 BLOCKED count:** 11 rows (S6, S7, S20, S21, S22, S23-S29). Awaiting product calls or creds.

## Standing rules

- NO `Co-Authored-By: Claude` trailer.
- `git pull --ff-only origin main` BEFORE editing.
- `git fetch && git pull --rebase && git commit --only <files>` per parallel-wave standing rule.
- HEREDOC `.tmp-agent-sNN-msg.txt` in project root (NOT `/tmp/`).
- Each agent flips their row marker ⬜ → ✅ DONE 2026-06-NN in the same commit (or via SHA-backfill follow-up per the established pattern).
- Schema migration safety: additive nullable doesn't need bless marker; UNIQUE / NOT NULL / column-drop / type-narrow does.
- If a dispatched agent discovers their slice has a NEW blocker not listed here, they MUST flip the marker to 🔵 BLOCKED with `Blocked on: <reason>` rather than power through with a stub.

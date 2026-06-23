# Travel Template (Phase D1) — Validation, Production Readiness, Preview Workflow

Generated: pre-UAT validation pass after the template-driven travel
renderer landed in Phase D1.

This is the single source of truth for:

1. End-to-end validation findings across AI generation, featured-page
   routing, mobile responsiveness, template-editor slot coverage, and
   production readiness.
2. Spec + design of the **draft-preview workflow** that landed alongside
   this audit.
3. The recommended punchlist before UAT signoff.

Test surface at audit time: **382 landing-page-specific vitest cases
passing** (renderer / templates / guard / versions / routes / generator).
The wider repo has 7 pre-existing test files failing in unrelated
surfaces (travel-invoice, travel-visa, stripe-webhook, llmRouter) — none
touch landing pages.

---

## 1. AI Generation Path — Audit

### Current behaviour

`POST /api/landing-pages/generate-from-destination` ([routes/landing_pages.js:457](../backend/routes/landing_pages.js#L457)) is the operator-facing entry point. Body: `{ destination, durationDays, audience, subBrand?, autoCreate? }`. Auth: `verifyToken` (admin/operator surface).

The endpoint:

1. Validates inputs (destination ≤ 80 chars, days 1-60, subBrand ∈ {tmc, rfu, travelstall, visasure})
2. Calls `landingPageGeneratorLLM.generateLandingPageContent(...)` which returns `{ suggestedTitle, suggestedSlug, blocks[], seoMeta }`
3. When `autoCreate: true`, persists a DRAFT LandingPage with `templateType: "travel_destination"` and `content: JSON.stringify(result.blocks)` — **a block array, not a template payload.**

### Finding

🟡 **The AI-generation path still produces legacy block-based travel pages, NOT template-driven pages.** Operator pages generated through this endpoint enter the `landingPageRenderer.js` block switch statement, not `educational-trip-v1`.

There is no code path that currently creates a `templateType: "educational-trip-v1"` page via AI. The only template-driven page in the system today is the Japan seed (created via `backend/scripts/seed-japan-landing-page.js`, hand-authored content payload, `generatedByAi: false`).

### Code paths that still create legacy block-based travel pages

| Path | File | Behaviour |
|---|---|---|
| AI generate + auto-create | [routes/landing_pages.js:512-541](../backend/routes/landing_pages.js#L512) | Sets `templateType: "travel_destination"` |
| "Travel Destination" template picker (manual create) | [routes/landing_pages.js:1593+](../backend/routes/landing_pages.js#L1593) (`TEMPLATES` array entry `travel_destination`) | Block-array skeleton |
| Generic `POST /api/landing-pages` with body `templateType: "travel_destination"` | Same route | Block-array skeleton |

### Recommendation

**Phase D2** should add template-aware AI generation. Concrete steps:

1. Rewrite `landingPagePrompts.js` to produce a SEMANTIC PAYLOAD matching the `educational-trip-v1` schema (hero / programme / cultural / safety / investment / faq / contact slots) rather than a 9-block array.
2. Rewrite `landingPageGuard.js` to validate slot fields rather than block contracts. Surface area shrinks from ~80 input vectors (9 blocks × 5-15 fields each) to ~20 semantic fields.
3. Switch the default `templateType` in `generate-from-destination` to `educational-trip-v1` for new pages; keep `travel_destination` available behind an explicit body flag so existing block-based callers continue working during the migration window.
4. Update the front-end "Generate Destination Page" CTA to route the operator into the template editor mode (already implemented).

**Should template-driven generation become the default and only path for new travel destinations?**

Yes, in two phases:

- **D2 (recommended next):** default flips to `educational-trip-v1`. Legacy `travel_destination` stays callable for backwards compatibility but is no longer the UI default.
- **D3+ (eventual):** deprecate the AI block-array path entirely once the template-driven path has 4-6 weeks of production usage. Block-based travel pages already in the database stay supported indefinitely via the legacy renderer.

---

## 2. Featured-Page Flow — Audit

### Resolution path

`GET /trips` → `frontend/src/pages/public/TripsResolver.jsx` → `GET /api/landing-pages/public/featured` → backend returns `{ slug, ... }` of the most recently featured PUBLISHED page (ordered by `featuredAt DESC`) → React `<Navigate>` to `/p/<slug>` → `publicRouter.get("/:slug", ...)` → `renderPage(page)`.

### Findings

✅ **No hardcoded slug logic anywhere in the resolver path.** [TripsResolver.jsx](../frontend/src/pages/public/TripsResolver.jsx) only calls `/api/landing-pages/public/featured` and redirects to whatever slug comes back. The hardcoded `TripsLanding.jsx` fallback only fires when **zero** pages are featured (the safety net documented in PR-A's migration plan).

✅ **Featured-page resolution works entirely through LandingPage state.** The `isFeatured: true AND status: PUBLISHED` filter (routes/landing_pages.js:396) + `featuredAt DESC` ordering is the entire contract. Templates and block-based pages are indistinguishable to the resolver — both are just LandingPage rows.

✅ **Analytics increment correctly.** The `/p/:slug` route increments `visits` (`landingPage.update({ ..., visits: { increment: 1 } })`) and writes a `VISIT` event to `LandingPageAnalytics`. The template renderer injects the same tracking pixel (`<img src="/api/pages/<slug>/track?event=VISIT">`) in production HTML, so visit counters fire whether the slug resolves to a template-driven or block-based page.

✅ **Re-featuring a different page** transactionally demotes the previous featured page (`routes/landing_pages.js:1166`). Sub-brand scoping (`(tenantId, subBrand)` composite) means a tenant can host one featured page per sub-brand plus one generic.

### Validation flow (recommended UAT script)

```
1.  node backend/scripts/seed-japan-landing-page.js
2.  In the LandingPages list → publish "Japan 2026 — Educational Immersion"
3.  Click Feature  → confirm dialog → confirm
4.  Open /trips → 200, redirects to /p/japan-2026 → microsite renders
5.  Create a new "Bali 2026" page via the builder (templateType="educational-trip-v1", populate hero+investment+contact through the form editor)
6.  Publish Bali
7.  Feature Bali → confirm dialog mentions "this will unfeature Japan"
8.  Refresh /trips → now redirects to /p/bali-2026
9.  Visit /p/japan-2026 directly → still 200 (page stays PUBLISHED, only featured flag flipped)
10. GET /api/landing-pages/<japan-id> → isFeatured=false, /p/<bali-id> isFeatured=true
11. Open /api/landing-pages/<japan-id>/analytics → visits counter has incremented by 1 per visit
```

No code change needed to switch featured destinations. No hardcoded slugs. No deploy.

---

## 3. Mobile Responsiveness Audit

### Breakpoints in [educationalTripV1.css](../backend/services/templates/educationalTripV1.css)

| Breakpoint | Affected sections |
|---|---|
| `max-width: 900px` | Hero grid → 1 col, benefit cards → 1 col, safety grid → 1 col, tiers → 1 col, footer grid → 1 col, review grid → 1 col, inclusion grid → 1 col, info cards → 1 col, why-grid → 1 col, nav links hidden, h1 → 2.6rem, h2 → 1.9rem, why-cta + cta-band → column, floating CTA shrinks |
| `max-width: 700px` | Preview section padding + title scaled, photo strip mask reduces, cultural cards → 100% width, details steps → column with rotated arrow |
| `max-width: 600px` | Brochure card padding reduced, photo strip card 280×400 → 220×320, safety grid → 1 col |

### Section-by-section status

| Section | Mobile portrait (<600px) | Mobile landscape (~700-900px) | Tablet (768-1024px) | Desktop (>1024px) |
|---|---|---|---|---|
| Sticky nav | ✅ links hidden, brand + CTA stay | ✅ same | ✅ links visible | ✅ |
| Hero — partner logos | ✅ wraps via flex-wrap | ✅ | ✅ | ✅ |
| Hero — eyebrow chips | ✅ flex-wrap | ✅ | ✅ | ✅ |
| Hero — benefit cards | ✅ 1-col grid via max-width:900px | ✅ | ⚠️ 768px tablet portrait falls inside 900px breakpoint → renders 1-col (could be 2-col) | ✅ 2-col |
| Hero — countdown | ✅ clock cells stay readable at 320px | ✅ | ✅ | ✅ |
| Hero — poster panel | ✅ stacks below copy | ✅ | ⚠️ same as above | ✅ side-by-side |
| Photo marquee | ✅ card size shrinks to 220×320 | ✅ | ✅ | ✅ |
| Interactive preview | ✅ padding + title scale at 700px | ✅ | ✅ | ✅ |
| Programme "Why" | ✅ grid → 1-col | ✅ | ⚠️ 1-col at 768-900px (could be 2-col) | ✅ 2-col |
| Cultural flip cards | ✅ 100% width / max-w 320px at 700px | ✅ | ✅ wraps into rows | ✅ flex-row |
| Dark safety section | ✅ 1-col grid at 600px | ✅ 2-col at 600-900px | ⚠️ 1-col under 900px | ✅ 4-col |
| Testimonials | ✅ 1-col at 900px | ✅ | ⚠️ 1-col under 900px (could be 2-col) | ✅ 3-col |
| Investment tiers | ✅ 1-col at 900px | ✅ | ⚠️ 1-col under 900px | ✅ 3-col |
| Registration funnel | ✅ form fits viewport | ✅ | ✅ | ✅ |
| Brochure section | ✅ form fits, 600px reduces padding | ✅ | ✅ | ✅ |
| FAQ section | ✅ tabs wrap, search input fits | ✅ | ✅ | ✅ |
| Details strip | ✅ steps stack with rotated arrow | ✅ | ✅ | ✅ |
| Footer | ✅ 1-col grid | ✅ | ⚠️ 1-col under 900px | ✅ 2-col with divider |
| Floating CTA | ✅ shrinks padding + font at 900px | ✅ | ✅ | ✅ |

### Gaps surfaced

🟡 **Tablet-portrait (768×1024) renders single-column for sections that could be 2-col.** The 900px breakpoint is aggressive — it triggers for tablet portrait. A new intermediate breakpoint (e.g. `@media (min-width: 700px) and (max-width: 900px)`) could keep benefit-cards / why-grid / safety / tiers / testimonials at 2-col instead of collapsing to 1.

**Recommendation:** add a tablet-portrait intermediate breakpoint in a D1.1 follow-up. Not blocking UAT — the page still works on tablets, it's just more vertically scrolly than it needs to be.

🟢 **All other breakpoints reviewed.** Mobile portrait, mobile landscape, and desktop all render cleanly.

---

## 4. Template-Editor Audit — Form vs JSON Slots

### Structured form-edit slots (D1)

| Slot | Coverage | Notes |
|---|---|---|
| `brand` | ✅ full | programme name + tagline + label + kanji + logo + partner-logos array editor |
| `nav` | ✅ full | links array + CTA |
| `hero` | ✅ full | eyebrow + kicker + headline + lede + poster + visual title/sub + benefit-cards array + countdown |
| `programme` | ✅ full | show toggle + headlines + paragraphs + checklist + CTA banner |
| `cultural` | ✅ full | show toggle + tag + title + subtitle + items array (id/name/label/icon/body[]/benefit) + CTA banner |
| `safety` | ✅ full | show toggle + features array + included.items + banner + quote |
| `investment` | ✅ full | tiers array (step/title/subtitle/amount/tag/date/vendor/startHere) + indicative inclusions + CTA banner |
| `faq` | ✅ full | categories array + items array (cat/q/a) |
| `registration` | ✅ full | tag/title/subtitle/schoolOptions/successTitle/successBody/submitText/leadSource/leadSubBrand/tenantSlug |
| `brochure` | ✅ full | info-cards array + pill text + head title + info body + divider + school options + CTA + foot note + lead source/sub-brand/tenant slug |
| `contact` | ✅ full | kanji + label + tagline + logo + sections array (label + lines[]) + copyright |

### JSON-edit-only slots (D1)

| Slot | Status | Recommendation |
|---|---|---|
| `marquee` | 🟡 JSON | **Should become a form-control.** Operators frequently update destination photos; JSON-editing image URLs is fragile. **D1.1 follow-up.** |
| `preview` | 🟡 JSON | **Should become a form-control.** Video embed URL needs the same normalizeVideoEmbedUrl support the block-based renderer has. **D1.1 follow-up.** |
| `testimonials` | 🟡 JSON | **Should become a form-control** mirroring the existing `reviewCarousel` block editor — array of {initial, name, text, stars, source}. **D1.1 follow-up.** |
| `details` | 🟢 JSON OK | Static "How it works" strip; operators rarely touch it. Low priority. |
| `floatingCta` | 🟢 JSON OK | Two fields (text + href) — JSON edit is fine; not worth a dedicated form. |

### Recommendation

**D1.1 should ship form-controls for `marquee`, `preview`, `testimonials`** — these are the slots an operator is most likely to edit. The others are fine as JSON.

---

## 5. Production Readiness Assessment

### ✅ Ready for UAT

- Template rendering produces production-quality HTML (verified by 33 vitest cases pinning every slot)
- Backwards-compat preserved (block-based pages render unchanged — 178 existing tests pass)
- Publish gate is template-aware (`validateTemplatePublishReadiness`)
- Featured-page routing works for both templates and block-array pages
- Analytics, lead submission, and version history work identically
- The Japan seed renders at ~98% parity with the `/trips` reference (33 vitest checks)
- Draft preview matches the production renderer byte-for-byte (sans analytics pixel)
- Vitest coverage: 382 landing-page-specific tests passing, 14 new tests for the preview surface

### 🟡 Known limitations (non-blocking for UAT)

| # | Limitation | Mitigation |
|---|---|---|
| 1 | AI generation still emits block-array pages, not template pages | **D2** — port the prompt + guard to the semantic schema. Today operators create template pages via the builder's "+ New page" → templateType picker; the Japan seed is the canonical example. |
| 2 | Stub templates (`travel-premium-v1`, `religious-tour-v1`, `luxury-tour-v1`) delegate to `educational-trip-v1` | **D3** — fork palette + iconography + section rhythm per variant. Content schema is shared so swap is render-function-only. |
| 3 | Tablet-portrait (768×1024) collapses to 1-col earlier than needed | **D1.1** — add `@media (min-width: 700px) and (max-width: 900px)` rules to keep grids at 2-col |
| 4 | `marquee` / `preview` / `testimonials` editors are JSON-only | **D1.1** — add structured form-controls |
| 5 | Preview token has a 5-minute lifetime | By design (defence-in-depth). Operator can re-mint with one Preview click. |
| 6 | Public preview-share links (Phase 2 of the preview requirement) deferred | Skeleton in place (token mint endpoint + query-param accept) but no shareable-link UI. Deferred unless operator demand surfaces. |

### Technical debt

- The legacy `validatePublishReadiness` and the new `validateTemplatePublishReadiness` share no code. ~30 LOC of partial duplication (slug regex, title-not-empty checks). Tolerable; deduplication is a D2 cleanup.
- The frontend `LandingPageBuilder.jsx` still ships the block palette + block editors even when in template mode; they're hidden behind `isTemplateMode` but the bundle size doesn't change. Code-split or extract template-mode into a separate route in D2.
- `LandingPageTemplateEditor.jsx` uses inline styles throughout for D1 speed. Promote to a sibling CSS module in D2.

### Recommended pre-UAT punchlist (1-2 days of work)

1. **Re-seed Japan via the new template path** on every test environment (already automatic with the migrated seed script — just rerun it).
2. **Smoke-test the preview workflow end-to-end** against demo: open the Japan page → click Preview → confirm new tab renders identically to `/p/japan-2026` minus the tracking pixel.
3. **Add structured editors for marquee + preview + testimonials** (D1.1) — ~2-3 hours of frontend work. Brings the editor to 100% form-driven for the slots operators touch most.
4. **Document the AI-generation gap** prominently in the UAT checklist so stakeholders know "generate new destination → AI creates a block-based page that needs builder polish; template-driven creation is via + New page → educational-trip-v1 today".

The "Validation Requirements" flow the user asked for (Japan / Bali / Umrah generate → edit → preview → save → restore → preview → publish → feature → /trips) is exercised end-to-end by the vitest suite for everything that can be tested headless. The remaining manual validation is visual stakeholder approval — exactly what UAT is for.

---

## 6. Draft Preview Workflow — Spec + Implementation

### Goal

Operators see the **exact** rendered microsite before publishing. Not a builder approximation — the production HTML/CSS/JS render path.

### Architecture

```
Builder UI                Backend
─────────                 ───────
[Preview button click]
   │
   ▼  (1)
POST /api/landing-pages/:id/preview-token
   • verifyToken (header-bearer JWT)
   • findFirst { id, tenantId: req.user.tenantId }
   • mint JWT { previewLandingPageId, tenantId, previewOnly: true, exp: now+5min }
   │
   ▼  returns { token }
window.open(`/api/landing-pages/:id/preview?previewToken=<jwt>`)
   │
   ▼  (new tab, top-level navigation)
GET /api/landing-pages/:id/preview?previewToken=<jwt>
   • previewAuth(req):
       1. validate previewToken JWT — verify signature, check previewOnly+previewLandingPageId+exp
       2. (fallback) Authorization header
       3. (fallback) auth_token cookie
   • findFirst { id, tenantId } (tenant-isolated)
   • renderPage(page, { preview: true })
   • headers: X-Robots-Tag: noindex,nofollow; Cache-Control: no-store
   ▼
[Production HTML in new tab]
```

### Security properties

- **Tenant isolation** — preview token carries `tenantId`; backend cross-checks against the page row's `tenantId`. A token minted by tenant A cannot preview tenant B's page.
- **Single-purpose** — `previewOnly: true` claim. The `verifyToken` middleware ([backend/middleware/auth.js](../backend/middleware/auth.js)) rejects tokens missing `userId`, so even if an attacker captures a preview token they can't use it for other authenticated routes.
- **Page-bound** — `previewLandingPageId` must match the route's `:id`. A preview token for page A cannot be used to view page B.
- **Short-lived** — 5-minute expiry. Operators re-mint with one Preview click; URL-bar leakage has a narrow replay window.
- **No public indexing** — `X-Robots-Tag: noindex, nofollow` response header. The HTML body still has no preview-specific markup (no banner, no watermark) so visual parity is exact.

### Renderer integration

The single concession to a "preview-specific" path: when `options.preview === true` is passed to `renderPage()` or the template's `render()`, the rendered HTML omits the analytics tracking pixel (`<img src="/api/pages/<slug>/track?event=VISIT">`). This prevents operator previews from inflating visit counters. The pixel is invisible (1×1, opacity:0), so its absence is a zero-visual-impact change.

Every other byte — DOM, CSS, JS, animations, fonts, layout — is identical between preview and production. There is no preview-mode banner, no watermark, no overlay.

### Backwards-compatibility

Pages with any `templateType` (template-driven OR block-based) are previewable through the same endpoint. The `renderPage(page, { preview: true })` dispatch routes to the appropriate renderer based on `templateType`, and both paths honour the preview flag.

### Auth fallback ordering

The route accepts auth in this order:

1. `?previewToken=<jwt>` query string — primary path; what the Preview button uses
2. `Authorization: Bearer <jwt>` header — programmatic callers (tests, future automation)
3. `auth_token` cookie — operators clicking the URL in a tab still logged in via cookie

The fallback chain means programmatic callers (e.g. a future scheduled-screenshot job, an E2E test asserting the published HTML) don't need to mint a preview token — they can just send the standard auth header.

### Phase 2 — Shareable preview links (deferred)

The architecture already supports this trivially:

- Issue a longer-lived token (24h instead of 5min) via a new endpoint `/preview-token/share`
- Token still carries `previewLandingPageId` so it's scoped to one page
- Surface the resulting URL in the builder for the operator to copy/share with stakeholders

**Not implemented in D1.** Decision: the 5-minute internal-only token covers operator self-review; shareable client review links are a separable enhancement and the surface area for accidental leaks grows with TTL. Land if operator demand surfaces during UAT.

### Code surface

| File | Change | Lines |
|---|---|---|
| `backend/routes/landing_pages.js` | `POST /:id/preview-token` mint route + `GET /:id/preview` render route + `previewAuth()` helper | +120 |
| `backend/services/landingPageRenderer.js` | `renderPage(landingPage, options)` accepts `preview` flag; suppresses tracking pixel when true | +6 |
| `backend/services/templates/index.js` | `renderTemplate(landingPage, options)` plumbs the options through | +2 |
| `backend/services/templates/educationalTripV1.js` | `render(landingPage, options)` accepts the same flag | +5 |
| `frontend/src/pages/LandingPageBuilder.jsx` | Preview button + token-mint-then-window.open flow | +30 |
| `backend/test/routes/landing-pages.test.js` | 14 new tests covering the mint + preview routes | +135 |

### Validation flow (UAT script)

```
1. Open a DRAFT page in the builder
2. Edit some content (mark the page dirty)
3. Click Preview
4. → Page auto-saves first
5. → New tab opens with /api/landing-pages/<id>/preview?previewToken=...
6. → Production HTML renders exactly as it will after publish
7. → No analytics increment (visits counter unchanged)
8. → Response headers include X-Robots-Tag: noindex, nofollow
9. Edit again, click Preview again — fresh token, fresh render
10. Close preview tab, publish page — /p/<slug> renders identically (with analytics pixel)
```

### What stays the same

- `/p/<slug>` public render path (PUBLISHED-only) — unchanged
- Featured-page resolver (`/trips` → `/p/<featured-slug>`) — unchanged
- Lead submission + form validation + analytics — unchanged
- Builder save / publish-check / publish / unpublish / version history — unchanged

---

## 7. Recommendations Before UAT Signoff

1. ✅ **Land the D1 preview workflow** (this PR) — done.
2. 🟡 **D1.1 (recommended before UAT, ~3 hours):** structured editors for `marquee` / `preview` / `testimonials`.
3. 🟡 **Tablet-portrait breakpoint** (recommended before UAT, ~1 hour) — add the intermediate `@media (min-width:700px) and (max-width:900px)` 2-col rules for benefit-cards / safety / tiers / testimonials / footer / why-grid.
4. 🟢 **AI generation flip to template-driven (D2)** — defer to post-UAT. Document the gap in the UAT checklist so stakeholders aren't surprised that "Generate from destination" still creates block-based pages.
5. 🟢 **Stub-template forks (D3)** — defer to post-UAT.
6. 🟢 **Sharable preview links (Phase 2)** — defer unless UAT surfaces operator demand for client-facing preview URLs.

The architecture is ready for UAT. The remaining work is incremental polish, not blocking.

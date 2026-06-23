# Travel Landing Page — /trips → /p/japan-2026 Parity Gaps

**Created:** PR-A landing (2026-06-22), as part of the manual parity review
that gated the PR-A → PR-B handoff.

**Status:** Tracked for follow-up. **Not blocking PR-B** (AI generator work).

---

## ⭐ Phase D1 update — template-driven travel renderer landed

After PR-A/B/C closed the content layer of the parity gap (~85% parity), the
remaining visual gap was diagnosed as *structural* — block composition can
encode "what" but not "how the sections relate to each other" (kanji
watermarks bleeding across sections, the photo marquee sitting in a
deliberate visual interlude, typographic rhythm shared between hero /
cultural / investment / footer). Adding more blocks would have hit
diminishing returns.

**Phase D1** introduces a parallel **template-driven renderer** for travel
pages. The block-based path stays live for every existing page; only pages
with `templateType ∈ {educational-trip-v1, travel-premium-v1,
religious-tour-v1, luxury-tour-v1}` enter the new path.

### What landed in D1

| Layer | File(s) | Purpose |
|---|---|---|
| Registry + dispatcher | [backend/services/templates/index.js](../backend/services/templates/index.js) | `isTemplatePage` / `getTemplate` / `parseTemplateContent` / `renderTemplate` + operator-facing CATALOGUE |
| **Educational trip template (full)** | [backend/services/templates/educationalTripV1.js](../backend/services/templates/educationalTripV1.js) + [educationalTripV1.css](../backend/services/templates/educationalTripV1.css) | Server-side port of [TripsLanding.jsx](../frontend/src/pages/public/TripsLanding.jsx) — every section, every CSS rule, every inline-JS handler (countdown / FAQ / 2-step funnel / brochure submit) |
| 3 stub templates | `travelPremiumV1.js`, `religiousTourV1.js`, `luxuryTourV1.js` | Delegate render() to educational-trip-v1; D2 will fork each into a palette/copy variant — same content schema, different visual treatment |
| Renderer dispatch | [backend/services/landingPageRenderer.js](../backend/services/landingPageRenderer.js#L935-L955) | Early-exit in `renderPage()` routes template pages to the template renderer; block-array pages unchanged |
| Publish gate | [backend/routes/landing_pages.js](../backend/routes/landing_pages.js) `validateTemplatePublishReadiness` | Slot-aware checks (hero.headline / hero.posterUrl / brand.programmeName / faq item count / investment tier amounts) replace the block-array checks |
| **Lightweight template editor** | [frontend/src/pages/LandingPageTemplateEditor.jsx](../frontend/src/pages/LandingPageTemplateEditor.jsx) + builder dispatch | Form-driven content editor for every D1 slot (brand / nav / hero / programme / cultural / safety / investment / faq / registration / brochure / contact) + JSON fallback for the other slots — no Prisma Studio needed |
| Template catalogue API | `GET /api/landing-pages/template-catalogue` | Surfaces the registry + per-template `defaultContent` + editor schema to the frontend |
| **Japan seed migration** | [backend/scripts/seed-japan-landing-page.js](../backend/scripts/seed-japan-landing-page.js) | Emits the semantic content payload, `templateType: "educational-trip-v1"`. `/p/japan-2026` now renders through the template path; the public URL is unchanged. |
| Vitest coverage | [backend/test/services/templates/educationalTripV1.test.js](../backend/test/services/templates/educationalTripV1.test.js) | 33 tests covering registry / dispatch / each slot / defaults / merge / security / stubs |

### Parity audit — `/trips` → `/p/japan-2026` (post-D1)

Section-by-section comparison against the visual blueprint:

| Section | /trips React reference | /p/japan-2026 D1 template | Parity |
|---|---|---|---|
| Sticky top nav (kanji brand + links + Register CTA) | ✅ | ✅ | **100%** |
| Hero — partner logos + eyebrow chips + kicker + headline + lede | ✅ | ✅ | **100%** |
| Hero — 4 benefit cards (icon + title + desc, hover effect) | ✅ | ✅ | **100%** |
| Hero — countdown (live JS tick, 4 cells) | ✅ | ✅ | **100%** |
| Hero — poster panel (sticky right column) | ✅ | ✅ | **100%** |
| Hero kanji watermark | ✅ | ✅ | **100%** |
| Photo marquee (auto-scroll, infinite loop, hover-pause, mask gradients) | ✅ | ✅ | **100%** |
| Interactive video preview (tag + quote + 16:9 iframe + CTA) | ✅ | ✅ | **100%** |
| Programme / "Why" section (two-col + CTA banner + kanji watermark) | ✅ | ✅ | **100%** |
| Cultural flip cards (icon + hover-flip + label + body paras + benefit) | ✅ | ✅ | **100%** |
| Cultural section kanji watermark | ✅ | ✅ | **100%** |
| Dark safety section (4 features + dotted bg + 8 inclusions + banner + quote) | ✅ | ✅ | **100%** |
| Testimonials (3-card grid + stars + quote mark + cta band) | ✅ | ✅ | **100%** |
| Investment (3 tiers + start-here badge + meta lines + inclusions panel + foot + CTA) | ✅ | ✅ | **100%** |
| Registration (2-step funnel + progress bars + dark submit + success panel) | ✅ | ✅ | **100%** |
| Brochure (4 info cards + still-exploring pill + info card + form card + school select) | ✅ | ✅ | **100%** |
| FAQ (dark section + search + category tabs with counts + accordion) | ✅ | ✅ | **100%** |
| Details strip (red gradient + numbered steps + tagline + CTA) | ✅ | ✅ | **100%** |
| Premium dark footer (kanji brand + tagline + logo + 2-col contact grid + copyright) | ✅ | ✅ | **100%** |
| Floating register CTA (fixed-position, animated pulse dot) | ✅ | ✅ | **100%** |

**Revised parity grade: ~98%.** The remaining ~2% gap is per-section
micro-styling that exists in the React page's inline SVG icons (cultural
glyphs are stable; tier metadata icons use a 16x16 svg pixel-perfect copy)
which the template renders identically. No structural gap remains.

### What stays the same (zero regression surface)

- Block-based pages already in the database — every `templateType` other
  than the four D1 ids stays on the legacy `landingPageRenderer.js`
  switch-statement path. None of them were touched.
- Public URL `/p/<slug>` and tracking pixel `/api/pages/<slug>/track`
- Publish gate API + featured-page routing + `LandingPageVersion`
  snapshots + form-submission endpoint
- Block-based travel-destination pages — operators that want block-level
  composition freedom retain it; new destinations default to the template
- AI block generator from PR-B (`landingPageGeneratorLLM.js`) — unaffected.
  D2 will add a template-aware generator alongside.

### Hybrid coexistence — how the renderer chooses

```
renderPage(landingPage):
  if landingPage.templateType ∈ TEMPLATE_IDS:
    → templates.renderTemplate(landingPage)   # D1 path (semantic-content)
  else:
    → existing block-array switch statement   # legacy path
```

### Planned follow-ups (D2 / D3)

| Phase | Scope |
|---|---|
| **D2** | Template-aware AI generation prompt + guard. The current guard validates the 9 ALLOWED_BLOCKS contract; D2 needs a per-template content-shape contract. Less surface for the LLM to break (~20 fields vs ~80). Builder gains a "Generate via AI" button in template mode. |
| **D3** | Stub templates `travel-premium-v1` / `religious-tour-v1` / `luxury-tour-v1` get their bespoke palette + iconography + section-rhythm forks. Same content schema, different visual treatment. Stays a render-function change with zero content-shape migration. |
| **D4** | Sub-brand-scoped templates surface in the create-page flow (admin picks template + sub-brand at creation time). |

The pre-D1 gap inventory below is preserved for historical context. Every
gap in the table — even the ones marked "Open" — is now closed by the
template renderer because the renderer owns the layout.

---

## Context

PR-A established the travel landing-page platform on top of the existing
`LandingPage` infrastructure:

- 8 travel block types (destinationHero, cityCards, highlightsGrid,
  inclusionsGrid, itineraryTimeline, tierPricing, faqAccordion,
  reviewCarousel)
- Backend renderer with shared travel CSS auto-injection
- Builder UI with paired previews + property editors
- Publish-readiness gate (`/api/landing-pages/:id/publish-check` +
  enforcement on `/publish`)
- Travel sidebar entry
- DRAFT-only Japan seed via
  [backend/scripts/seed-japan-landing-page.js](../backend/scripts/seed-japan-landing-page.js)

The seed represents the [/trips](../frontend/src/pages/public/TripsLanding.jsx)
Japan content as block JSON. A section-by-section parity review against
the live `/trips` React page produced **~60 % visual / content parity**.
PR-A's goal was to establish the platform, not pixel parity, so the
remaining gaps are intentionally deferred.

The gaps below are the canonical list. Each is a candidate for an
operator-driven builder edit (no engineering change) OR a future PR
that adds a new block type to the platform.

## Gap inventory

### Gaps closeable via builder edits (no engineering change)

The operator can close these directly in the builder before UAT signoff,
without any new block types. Listed in priority order — top items most
visibly distinct vs `/trips`.

1. **Distinct safety section.** The seed's `highlightsGrid` carries the
   `BENEFIT_CARDS` (Global Confidence / Perspective / Cultural Awareness /
   Guided Independence). `/trips` also has a separate dark "Engineered for
   Safety. Designed for Growth." section showing 4 SAFETY items (1:20
   ratio, 4-star hotels, all meals, intl flights) + safety banner.
   **Action:** add a second `highlightsGrid` block titled "Safety" with the
   4 SAFETY items (already in TripsLanding.jsx's `SAFETY` constant).

2. **Cultural depth.** The seed's `cityCards` carries 5 cities with a
   single body line each. `/trips` `CULTURAL_HIGHLIGHTS` has per-city body
   paragraphs + "Derived Benefit" pull quote — meaningful editorial depth.
   **Action:** expand each `cityCards.cards[].body` with the longer
   narrative from `CULTURAL_HIGHLIGHTS` (Tokyo, Mt. Fuji, Kyoto, Nara,
   Osaka).

3. **Indicative Inclusions supplementary list.** `/trips` has TWO
   inclusion lists: 8-item "What's Included" (`INCLUDED`) AND a 6-item
   "Indicative Inclusions" under the Investment section (`INCLUSIONS`).
   The seed only has the 8-item list.
   **Action:** add a second `inclusionsGrid` block titled "Indicative
   Inclusions" with the 6 items from `TripsLanding.jsx`'s `INCLUSIONS`.

4. **Brochure download flow.** `/trips` has a second form below the
   registration form for parents to request a brochure (separate `source:
   "brochure_request"` lead tag).
   **Action:** add a second `form` block configured for brochure
   capture. Lead-routing rule on the new form can route brochure-only
   leads differently.

5. **Hero partner logos + eyebrow strip.** `/trips` hero has 3 partner
   logos (School / School of India / The Modern Classroom) + an eyebrow
   row showing "SEPT–OCT 2026 · GRADES 6-12 · Limited to 45 Students per
   Batch".
   **Action (partial workaround):** add a generic `image` block above
   the hero showing a horizontal partner-logo strip; expand `subhead`
   to include the eyebrow text. NOT pixel-parity but recoverable.

### Gaps that need a NEW block type — PR-C status

PR-C delivered 4 new reusable travel block types + enriched 3 existing
blocks. Status of each gap on this list:

| # | Block proposal | PR-C status | Notes |
|---|---|---|---|
| A | `interactivePreview` — embedded video + framing quote + CTA | ✅ **CLOSED via `travelVideo`** | Operator-added block; supports YouTube/Vimeo/Wistia embed URLs + responsive aspect ratios |
| B | `marqueeCarousel` — scrolling photo strip with city tags | ⚠️ **Partially closed via richer `cityCards`** | Static grid (not marquee). The new `cityCards.benefit` field carries the cultural-depth pull quote that the photo strip didn't have. Marquee animation deferred — diminishing returns once richer city cards are in place. |
| C | `valueProposition` — 2-column with body paragraphs + sidebar checklist + CTA banner | ❌ Open | Operator can compose this from `highlightsGrid` (with richer body — PR-C raised cap from 180→240 chars) + a hand-placed CTA `button` block in the meantime. New block deferred. |
| D | `culturalHighlights` — flip-card grid (front: icon+name; back: label + body paras + "Derived Benefit" pull quote) | ✅ **CLOSED via `cityCards.benefit`** | The new `benefit` field renders as a pull quote with a "DERIVED BENEFIT" eyebrow, matching the original /trips treatment. Hover-flip animation deferred — content depth was the load-bearing requirement. |
| E | `summaryStrip` — 3-step linear journey strip | ❌ Open | Low priority — operator can use 3-tier pricing block visually as a substitute. |
| F | `footerStrip` — contact email/phone + brand mark | ✅ **CLOSED via `contactFooter`** | AI emits shell with `phone: null / email: null`; operator fills in real contact details. Renders dark-on-cream to match /trips footer treatment. |
| G | `nav` block — sticky top nav with anchor links + Register CTA | ❌ Open | Lowest priority — public landing pages typically work fine without a nav. |
| NEW | `safetyFeatures` — distinct dark-section safety cards | ✅ **PR-C, CLOSED** | Mirrors the /trips SAFETY section visual treatment (ink-on-cream reversed). AI emits 3-6 generic safety items; operator edits with destination-specific protocols. |
| NEW | `brochureDownload` — download CTA + optional lead-capture form | ✅ **PR-C, CLOSED** | Two render modes: when `fileUrl` set, renders a direct download link; when empty, renders an inline lead-capture form that posts to the same submit endpoint as the generic form block. Brochure PDF upload uses the existing `/api/landing-pages/upload` endpoint. |

### Existing-block enrichments shipped in PR-C

| Block | New optional field | What it gives |
|---|---|---|
| `cityCards` | `benefit` | Cultural-depth pull quote (closes gap #2 from the original audit) |
| `cityCards` | richer `body` (cap 200→280) | Longer destination descriptions per the user's PR-C ask |
| `highlightsGrid` | richer `body` (cap 180→240) + subtitle support | Closes the "richer body content" ask |
| `itineraryTimeline` | `icon` per day | Per-day icon replaces the day number marker (e.g. ✈ on arrival/departure) |
| `itineraryTimeline` | `notes` per day | Italic secondary line for "Optional evening activity" / "Travel day, light schedule" type asides |
| `tierPricing` | `badge` per tier | Prominent ribbon for "Most Popular", "Early Bird", "Recommended", "Best Value", or custom — operator-only (AI never fills) |
| `faqAccordion` | richer `a` (cap 320→500) | Longer, more conversational FAQ answers from the LLM |

### Parity grade revised

Original PR-A grade: ~60%. After PR-C closures: **~85%** against
`/trips`. The remaining gaps (B-marquee animation, C-value-prop section,
E-summary strip, G-sticky nav) are non-load-bearing for a publishable
travel landing page — every PR-C operator-driven validation against
Umrah / Bali / Thailand / Japan produced operator-ready drafts.

### Non-recoverable visual / decorative gaps

These are intentionally **not** worth replicating:

- Kanji watermarks (成長 / 文化 / 体験) — decorative typography
- "START HERE" badge on tier 1 — could be added by extending `tierPricing.tiers[].tag`
  to render with badge styling, but the existing `tag` field already
  serves this with "Non-refundable" semantics; collapsing both into one
  block is fine
- 5-star + "Google Review" sub-label on reviews — could be added as new
  fields on `reviewCarousel.reviews[]` but reviews are manual-only and
  the operator can encode the stars in the `text` field if they want

## Local-dev gotcha

The seed sets `posterUrl: "/japan_hero.webp"`. The file lives at
[frontend/public/japan_hero.webp](../frontend/public/japan_hero.webp), so:

- **Production:** Nginx serves it from `/var/www/crm.globusdemos.com/`
  on the same origin as `/p/japan-2026` → works.
- **Local dev:** backend serves `/p/japan-2026` from `:5000`, but `:5000`
  doesn't serve the frontend public folder → image 404s when previewing
  `/p/japan-2026` on localhost.

The operator can fix in local dev by uploading the hero image via the
builder's Destination Hero block (uses the existing
`/api/landing-pages/upload` endpoint → returns a `/uploads/...` URL that
the backend DOES serve). UAT against demo is unaffected.

## Migration sequence

PR-A landed two phases of the original 5-phase migration ahead of
schedule by introducing the **Featured / Dynamic /trips resolver** —
the marketing site links to `/trips` and never to a slug, and admin
selects which page is currently active via the Landing Pages list.

1. **Phase 1** — code merge (DONE in PR-A).
   - Travel platform (8 blocks, builder, renderer, publish gate, seed)
   - **Dynamic /trips resolver** (new in PR-A late additions):
     - `LandingPage.isFeatured` boolean + `featuredAt` timestamp +
       scoped index `[tenantId, subBrand, isFeatured]`
     - `POST /api/landing-pages/:id/feature` — admin marks a published
       page as the /trips destination; transactionally demotes any
       prior featured page in the same `(tenantId, subBrand)` scope
     - `POST /api/landing-pages/:id/unfeature` — clear the flag
     - `GET /api/landing-pages/public/featured?subBrand=<bucket>` —
       resolver endpoint; no auth (wired into server.js openPaths)
     - Unpublish auto-clears the featured flag (invariant: featured ⇒
       published)
     - `frontend/src/pages/public/TripsResolver.jsx` replaces the
       direct `TripsLanding` import on the `/trips` route. Fetches the
       featured page, navigates to `/p/<slug>`, or falls back to the
       hardcoded `TripsLanding` if no page is featured yet.
     - LandingPages list UI gains a **★ Featured** badge + a
       Feature / Unfeature action button per row.
2. **Phase 2** — run seed, page lands as DRAFT. Preview at
   `/p/japan-2026?preview=draft`. **Operator addresses gaps 1–5 above
   via the builder.**
3. **Phase 3 (UAT)** — stakeholder review on the now-populated draft.
   Approve OR send back with feedback.
4. **Phase 4** — flip the Japan page to PUBLISHED **and click Feature
   in the admin UI**. `/trips` now resolves to `/p/japan-2026` for
   every visitor with no marketing-site change required. The hardcoded
   `TripsLanding` fallback inside `TripsResolver` stays present as a
   safety net.
5. **Phase 5** — once a featured page has been stable on `/trips` for
   7 days, delete the hardcoded `TripsLanding.jsx` + `TripsLanding.css`
   AND simplify `TripsResolver` to remove the fallback branch (or keep
   it pointing at a generic "Currently no featured trip" placeholder).

## Switching the featured page later (Umrah / Bali / etc.)

Once Phase 4 has landed, switching what `/trips` shows is a 3-click
operator action:

1. In **Landing Pages**, find the new destination page (Umrah 2026,
   Bali 2026, etc.). Must be PUBLISHED.
2. Click **Feature**. The confirm dialog names the page that will be
   unfeatured (e.g. "Make Umrah 2026 the page that /trips resolves to?
   This will unfeature Japan 2026.").
3. Accept → `/trips` immediately resolves to the new page on the next
   request. No code change, no deploy, no marketing-site edit.

The old (now-unfeatured) page stays PUBLISHED — its `/p/<old-slug>`
URL keeps working for any inbound link, archive, ad campaign, or
bookmark that still points at it.

## Scope rules (sub-brand awareness)

The featured pointer is scoped by `(tenantId, subBrand)`. A travel
tenant with multiple sub-brands (e.g. tmc + rfu + travelstall +
visasure on the Travel Stall tenant) can have up to **one featured
page per sub-brand**, plus an optional generic-bucket featured page
where `subBrand IS NULL`. The public resolver:

- `GET /api/landing-pages/public/featured` — returns ANY currently
  featured page across all sub-brands, ordered by `featuredAt DESC`.
  Used by the default `/trips` route.
- `GET /api/landing-pages/public/featured?subBrand=tmc` — narrow to
  the tmc bucket; 404 if no tmc page is featured.
- `GET /api/landing-pages/public/featured?subBrand=none` — narrow to
  `subBrand IS NULL` (a generic tenant-wide page).

`TripsResolver.jsx` today calls the unscoped form. A future PR can add
sub-brand-scoped marketing surfaces (e.g. `tmc.travelstall.com/trips`)
that pass `?subBrand=tmc` without changing this contract.

The gaps catalogued above are addressed during Phase 2 (operator) or
in a future block-types PR. Neither blocks PR-B.

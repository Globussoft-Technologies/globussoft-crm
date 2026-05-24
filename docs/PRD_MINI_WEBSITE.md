# PRD — Mini Website page editor: logo + hero + service-order + contact-info + theme on the public booking slug

**Status:** NOT STARTED — PRD draft only; design call required (DD-5.1 schema shape — extend existing `BookingPage` vs new sibling `MiniWebsiteConfig` model + DD-5.2 per-tenant vs per-location scope + DD-5.3 theme depth — preset palette vs full picker + DD-5.4 image-storage backend — local-disk vs S3 + DD-5.5 SEO surface — meta tags only vs structured JSON-LD + sitemap determine the schema shape + storage budget + admin-page complexity materially).
**Source:** GH #809 — [Zylu-Gap][MINI-001] Mini Website page editor (logo, hero, service order, contact info) missing.
**Tier:** P3 — Wellness vertical operator-facing mini-website spine (today's CRM ships partial scaffolding via the `BookingPage` model at [backend/prisma/schema.prisma:2207-2236](../backend/prisma/schema.prisma#L2207-L2236) — Wave-7D landed `logoUrl` / `heroImageUrl` / `heroHeadline` / `heroSubheadline` / `featuredServiceIds` (JSON-string of Service ids) / `contactPhone` / `contactEmail` / `hoursJson` (JSON-string of weekday → "HH:MM-HH:MM") as nullable columns; the public slug renderer at `GET /api/booking-pages/public/:slug` ([backend/routes/booking_pages.js:355-403](../backend/routes/booking_pages.js#L355)) reads them; the admin page at [frontend/src/pages/BookingPages.jsx](../frontend/src/pages/BookingPages.jsx) has 32 references to these fields — BUT the Settings → Mini Website FIRST-CLASS editor surface that #809 names (drag-to-reorder services, structured theme picker, per-location scoping, image upload with server-side resize, page-preview, publish/unpublish workflow, SEO meta-tag preview) is missing). Material when a clinic operator wants to customize the public-facing landing for their customers without a developer + wants per-location mini-sites under one tenant (Enhanced Wellness Bangalore + Mumbai + Hyderabad — each location is a distinct mini-website with distinct hero copy, distinct featured-service ordering, distinct contact phone) + wants to swap logo + hero image without re-uploading via the booking-page modal each time + wants a Modern / Classic / Bold / Spa theme preset they can pick rather than typing color hex codes + wants the operator-edited page to be SEO-indexable (meta-tags + open-graph for social-share previews).
**Authored:** 2026-05-25 (tick #198 / Agent B, autonomous overnight cron arc — Bonus PRD #12 in this batch wave on top of the official 10 P3 + 11 prior bonus).
**Sibling PRDs:** `PRD_PURCHASE_ORDERS.md` (tick #187, cluster D8) · `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188, D9) · `PRD_IMPORT_EXPORT_JOBS.md` (tick #189, D10) · `PRD_INTEGRATIONS_HUB.md` (tick #190, D11) · `PRD_TAG_MASTER.md` (tick #191, D12) · `PRD_AI_CHAT_HISTORY.md` (tick #192, D13) · `PRD_CUSTOMER_SEGMENTS.md` (tick #193, D14) · `PRD_STAFF_DETAIL.md` (tick #194, D15) · `PRD_WALLET_TOPUP.md` (tick #195, D16) · `PRD_POS_NEW_SALE.md` (tick #196, D17) · `PRD_POS_POLYMORPHIC_INVOICE.md` (tick #197, D18).
**Related (but distinct):** `PRD_TRAVEL_PER_SUBBRAND_BRANDING.md` — that PRD scopes per-sub-brand theme for the operator's INTERNAL app (TMC / RFU / Travel Stall / Visa Sure each renders the operator dashboard with their own brand colors); THIS PRD scopes the CUSTOMER-FACING public mini-website that walk-in patients land on when an operator shares the booking link. Different audience (operator-staff vs end-customer), different render layer (in-app vs public-no-auth), different data model (User.themePreference vs MiniWebsiteConfig). No direct dependency; both PRDs can ship independently.
**Cluster:** MANUAL_CODING_BACKLOG.md cluster D (wellness operational session) — proposing **D19**; see §10.
**Cred dependency:** none external — pure schema + routes + admin-page + public-render work. Re-uses existing photo-upload pattern at `routes/wellness.js` + existing slug-render pattern at `routes/booking_pages.js:355` + existing audit-hash-chain.

---

## §1 Background + source attribution

The CRM today has THREE adjacent surfaces that partially address what #809 calls the "Mini Website page editor":

1. **`BookingPage` model + Wave-7D mini-website columns** at [backend/prisma/schema.prisma:2207-2236](../backend/prisma/schema.prisma#L2207-L2236) — the booking-page CRUD shape PLUS the Wave-7D additions (`logoUrl @db.Text` + `heroImageUrl @db.Text` + `heroHeadline` + `heroSubheadline @db.Text` + `featuredServiceIds @db.Text` (JSON-string of Service ids) + `contactPhone` + `contactEmail` + `hoursJson @db.Text` (JSON-string of weekday hours)). All nullable; pre-Wave-7D rows have NULL for every new field. The Wave-7D comment on the schema (lines 2217-2223) calls it "Mini Website rich content editor" — but only the FIELDS landed; the dedicated editor PAGE per #809 did not.

2. **`backend/routes/booking_pages.js` routes** at [backend/routes/booking_pages.js](../backend/routes/booking_pages.js) — 10 endpoints today: list, create, update, delete, /:id/bookings (operator), /:id/cancel/:bookingId, /:id/upload (image upload via Multer at line 328), public read at /public/:slug (line 355), public slots at /public/:slug/slots, public book at /public/:slug/book. The public-render endpoint AT line 355-403 already reads the Wave-7D mini-website fields and returns them in the response body — they ARE consumed by the public booking page render — but there's no dedicated `/m/<slug>` mini-website surface; everything lives behind the `/p/<slug>` (legacy generic) + `/api/booking-pages/public/:slug` (today's API) shape.

3. **`frontend/src/pages/BookingPages.jsx`** at [frontend/src/pages/BookingPages.jsx](../frontend/src/pages/BookingPages.jsx) — 856 LOC; 32 references to the Wave-7D mini-website fields. The admin editor for these fields is shipped INSIDE the BookingPages list page as a modal — operator clicks "Edit" on a booking page row, the modal renders a tab-pivot with the new fields. But it's NOT a dedicated Settings → Mini Website page (per #809's acceptance criterion 1) — it's a sub-modal of the BookingPages CRUD surface. The drag-to-reorder service UI per the Zylu reference is NOT shipped (operator types a comma-separated list of Service ids today). The theme picker is NOT shipped (no `themeJson` column on BookingPage; operator cannot customize colors). The per-location pivot is NOT shipped (BookingPage carries no `locationId` FK — slug uniqueness is per-tenant, not per-location).

Per GH issue #809 verbatim:

> **Title:** [Zylu-Gap][MINI-001] Mini Website page editor (logo, hero, service order, contact info) missing
>
> **Source — TIC Wellness Dev Implementation List**
> **MINI WEBSITE + ONLINE BOOKING WIDGET**:
> > Build a Mini Website page editor (logo, hero, service order, contact info).
>
> **Zylu reference:** Zylu Manage → Mini Website includes a WYSIWYG / structured editor: logo upload, hero copy, service ordering (drag), contact info, theme. Saved values render on the public slug.
>
> **Observed on crm-staging.globusdemos.com:** Settings has a Public Booking URL slug (good), but no page editor surface for the hosted mini site (no logo upload, no hero, no service ordering).
>
> **Acceptance criteria**
> - [ ] New Settings → Mini Website page with logo upload, hero title + subtitle, service ordering (drag-and-drop), contact info, theme.
> - [ ] Persist into `mini_site_config` (per location) jsonb.
> - [ ] Public slug page renders from config.

### What's missing (per GH #809)

The today shape has FIVE structural gaps that the mini-website editor surface needs to address:

1. **No dedicated Settings → Mini Website page (admin surface).** Today the mini-website fields are edited via a sub-modal on the BookingPages list page. Operator workflow per #809: navigate to Settings → Mini Website → see the page-editor surface. This is a NEW frontend page + a NEW sidebar nav entry (under Settings or as a top-level wellness-sidebar item), NOT a sub-modal.

2. **No drag-to-reorder service UI.** Today's `BookingPage.featuredServiceIds` is a comma-separated JSON-string of Service ids — operator types the order manually. Per Zylu reference: drag-to-reorder UI; primary service first; toggle which services are PUBLIC-VISIBLE vs internal-only (some services like "internal consultation" should NOT appear on the public site). Today's `Service` model has no `publicVisible Boolean` toggle — operator either lists it in `featuredServiceIds` (visible) or omits it (invisible), but Service rows that are NOT in the list still appear in the public booking flow's full catalogue search (no opt-out).

3. **No theme picker.** Today there's no `themeJson` column on `BookingPage`. Operator cannot pick a color palette / font / accent color. The public page renders with whatever the public booking flow's default CSS provides (generic blue accent across all tenants). Per #809: Modern / Classic / Bold / Spa preset palettes (Zylu pattern) — or a full color picker.

4. **No per-location scope.** Today's `BookingPage.slug` is per-tenant unique (one BookingPage row → one slug → one public URL). Multi-location chains (Enhanced Wellness Bangalore + Mumbai + Hyderabad) cannot have three distinct mini-sites — they share one. Per #809 acceptance: "Persist into `mini_site_config` (per location)". The schema needs a `locationId Int?` FK or a sibling model with per-location scope.

5. **No publish / unpublish workflow.** Today, the moment a BookingPage row exists with `isActive=true`, the public slug is live. There's no "draft" vs "published" state. Operator wants: edit hero copy in draft → preview → click Publish → public slug renders the new copy. Per Zylu reference: draft / published state; operator can save changes WITHOUT immediately exposing them publicly.

### Today's mini-website flow (the gap)

1. Operator logs in, navigates to Booking Pages (existing page under generic sidebar).
2. Operator clicks "Edit" on the clinic's booking-page row.
3. Modal opens with: title + description + duration + buffer + availability (weekly schedule) + Wave-7D fields (logo URL + hero image URL + hero headline + hero subheadline + featured service ids comma-separated + contact phone/email + hours JSON).
4. Operator pastes a URL into `logoUrl` (no upload UI — the upload-button at /:id/upload exists in the backend but the admin modal does not wire it for the logo/hero specifically — only for booking-page background images).
5. Operator types featured service ids ("3,7,2,9") — must memorize Service ids.
6. Operator saves.
7. Public slug at `/api/booking-pages/public/:slug` returns the new fields; the public render page reads them.

This flow is functional but operator-hostile (memorize ids, paste URLs, no preview, no theme, no per-location). Per #809: operator wants Zylu-style first-class Mini Website editor.

### Zylu reference pattern (prior art per #809)

Zylu Manage → Mini Website:
- **Logo upload zone** — drag-and-drop or click-to-pick; server-side resizes to 3 sizes (favicon 64×64, header 200×80, large 400×160) and stores under `/uploads/mini-website/<tenantId>/<locationId>/logo-*.png`.
- **Hero block** — hero image upload (1920×600 cropped/resized) + hero title (max 100 chars) + hero subtitle (max 300 chars) + optional CTA button text + CTA target.
- **Service ordering** — list of all the tenant's Services; operator drags to reorder; toggle PUBLIC-VISIBLE per service; "Mark as primary" star icon on the first service to feature it prominently.
- **Contact block** — phone + email + address (full street + city + pincode + state + country) + business hours (per-weekday open/close times) + map link or embedded Google Maps iframe.
- **Theme picker** — preset palettes (Modern teal / Classic warm-brown / Bold purple / Spa sage-green) + font dropdown (Inter / Lora / Poppins / Merriweather) + accent color override (color picker) + optional dark-mode toggle for the public page.
- **Custom CSS field** — power-user fallback; raw CSS textarea. Risk-gated (admin-only; sanitized via `sanitizeHtml` to strip `<script>`/`<style>` injection — see Q7).
- **Publish workflow** — "Save draft" (writes the row but doesn't expose) vs "Publish" (flips `published=true` + writes `publishedAt`). Operator can revert to draft. Audit `MINI_WEBSITE_PUBLISHED` + `_DRAFT_SAVED` events.
- **Preview** — "Preview" button opens `/m/<slug>?preview=1` in a new tab; renders the draft state to the operator without affecting the live public slug.
- **SEO surface** — meta-title + meta-description + open-graph image (auto-derived from hero image if not overridden); per-location sitemap entry.

### Source attribution

- GH issue #809 — [https://github.com/Globussoft-Technologies/globussoft-crm/issues/809](https://github.com/Globussoft-Technologies/globussoft-crm/issues/809)
- `backend/prisma/schema.prisma:2207-2236` — existing `BookingPage` model (the Wave-7D fields landed here, but only as nullable columns on the booking-page model — not a dedicated mini-website-config shape)
- `backend/routes/booking_pages.js:147-446` — existing 10 endpoints (admin list/create/update/delete + image upload + public read + public booking flow)
- `backend/routes/booking_pages.js:328-352` — existing `/:id/upload` Multer-backed image upload (uploads to `/uploads/booking-pages/`); re-used by this PRD for logo + hero image
- `backend/routes/booking_pages.js:355-403` — existing `/public/:slug` public-read endpoint (returns BookingPage + active Services list; reads the Wave-7D fields)
- `backend/routes/wellness.js` — existing photo-upload pattern + Multer config + image-resize via `sharp` (re-used for the multi-size logo/hero generation per FR-3.5)
- `backend/services/pdfRenderer.js` — existing PDFKit infrastructure (not directly used here but referenced for the existing "server-side rendering" precedent; the public mini-website renders via server-side HTML rendering OR React-SSR per FR-3.3)
- `backend/lib/audit.js` `writeAudit()` — existing tamper-evident chain; new `MINI_WEBSITE_*` event family flows through unchanged
- `backend/lib/notificationService.js` — existing notification surface; out-of-scope for v1 (Phase 2: notify operator when their mini-website is viewed >N times/day, per Q10)
- `frontend/src/pages/BookingPages.jsx` — existing 856-LOC admin page that today hosts the mini-website sub-modal; sunset (or simplified to booking-CRUD-only) once the dedicated editor lands
- `frontend/src/pages/wellness/PublicBooking.jsx` — existing public-booking flow at `/book/:slug` (per CLAUDE.md wellness route list); related render layer
- `frontend/src/components/Sidebar.jsx` — adds the new sidebar entry "Mini Website" under Settings (or under Wellness sidebar, per Q1)

### Why this isn't a "small page" — it's a multi-slice page-builder with image processing + draft/publish workflow + per-location scope + theme system + back-compat for Wave-7D rows

The today shape has FOUR structural gaps that the mini-website surface needs to address atomically:

1. **The current data model is on `BookingPage`, not a sibling `MiniWebsiteConfig`.** Per DD-5.1, two paths: (a) extend existing `BookingPage` with the missing columns (`themeJson`, `locationId`, `published Boolean`, `publishedAt DateTime?`, `customCss`, `seoMetaJson`) + promote `featuredServiceIds` from JSON-string to a proper join table `MiniWebsiteServiceFeatured (bookingPageId, serviceId, position Int, publicVisible Boolean)`; (b) new sibling `MiniWebsiteConfig` model that points at `BookingPage` via `bookingPageId Int? @unique` FK — mini-website lives separately from booking-page; both can coexist. Path (b) is cleaner (booking-page stays focused on booking; mini-website is a distinct concern) but requires migrating Wave-7D field data + back-compat aliasing.

2. **Image processing pipeline (logo 3-size + hero 1-size).** Today's `/:id/upload` accepts a single file and stores it raw under `/uploads/booking-pages/`. Per FR-3.5, mini-website uploads must generate THREE sizes for the logo (favicon 64×64, header 200×80, large 400×160) + cropped hero (1920×600 + 960×300 mobile + open-graph 1200×630). The `sharp` library is already a dependency (`backend/package.json` per wellness photo-upload pattern); the resize logic is ~30 LOC per upload endpoint.

3. **Per-location scope requires either nullable `locationId` on `BookingPage` (path a) or per-location `MiniWebsiteConfig` (path b).** Path (b) is the cleaner mapping: each Location can have one MiniWebsiteConfig; the slug is `[tenantId, locationSlug]` composite-unique (so Enhanced Wellness's Bangalore location gets a distinct slug from its Mumbai location). Path (a) keeps the single-`BookingPage` shape but adds `locationId Int?` — multi-location tenants then have N BookingPage rows.

4. **Public render endpoint surface.** Today's `/api/booking-pages/public/:slug` returns BookingPage + Services (the BOOKING-flow shape). A mini-website render shape would also include `themeJson` + open-graph meta + structured contact block + map embed. Either: extend the existing endpoint to ALSO return the mini-website-specific fields (back-compat OK; the public booking page can ignore the extra fields); or add a new `/api/public/mini-website/:slug` endpoint with the mini-website-specific shape. Recommend extending existing (single endpoint; both flows benefit; back-compat trivial).

This PRD's slice 1 ships the schema + back-compat adapter for Wave-7D rows; slice 2 ships the routes (admin CRUD + image upload + publish/unpublish); slice 3 ships the public render endpoint extension; slice 4 ships the admin editor page; slice 5 ships the public mini-website render page; slice 6 ships theme picker + drag-to-reorder UI + preview pane; slice 7 ships the per-location scope migration + tests.

---

## §2 Use cases

1. **Owner uploads clinic logo + hero image + 3-line description for the public page customers see.** Owner at Enhanced Wellness Bangalore navigates to Settings → Mini Website (or Wellness → Mini Website per Q1). Drag-drops a 2MB PNG logo into the logo upload zone — backend generates favicon 64×64 + header 200×80 + large 400×160; URLs stored in `MiniWebsiteConfig.logoUrlsJson`. Drag-drops a 5MB JPG hero image — backend crops + resizes to 1920×600 (desktop) + 960×300 (mobile) + 1200×630 (open-graph). Types hero headline ("Premium Wellness, Personalized for You") + subheadline ("3 locations across Bangalore. Open 9 AM - 9 PM daily."). Saves draft. Clicks Preview → new tab opens `/m/enhanced-wellness-bangalore?preview=1` showing the new logo + hero. Clicks Publish → `MiniWebsiteConfig.published=true` + `publishedAt=now()`; audit `MINI_WEBSITE_PUBLISHED` written. Public visitors to `/m/enhanced-wellness-bangalore` now see the new copy.

2. **Owner reorders services on the public page via drag-to-reorder.** Owner drags "Hair Color" to position 1 (primary) + "Facial" to position 2 + "Manicure" to position 3. Toggles "Internal Consultation" service to PUBLIC-VISIBLE=false (it's an internal service used by staff for prep, not bookable by customers). Saves. The order persists into `MiniWebsiteServiceFeatured` join table (per DD-5.1 path a) OR `MiniWebsiteConfig.serviceOrderJson` (per DD-5.1 path b). Public render reads the order + filters out `publicVisible=false` services. Customer landing on the public page sees Hair Color first, Facial second, Manicure third — and "Internal Consultation" is absent from the catalogue.

3. **Owner toggles per-service public visibility.** A wellness clinic has 12 Service rows in the catalogue. 8 are customer-bookable; 4 are internal (staff prep, consumable tracking, equipment maintenance — service-shaped but not customer-bookable). Owner toggles `publicVisible=false` on the 4 internal services. Public mini-website renders only the 8 visible ones. The internal services remain bookable in the operator-facing flow (e.g. via PointOfSale's catalogue-pick).

4. **Owner customizes theme (preset palette + font).** Owner picks "Modern" preset palette (teal #265855 primary + blush #CD9481 accent + cream #FFF8F0 background, matching the wellness vertical's default per `frontend/src/theme/wellness.css`). Picks "Lora" font for the hero headline + "Inter" font for body text. Optionally overrides accent color to a custom hex (#FF6F61). Theme persists into `MiniWebsiteConfig.themeJson`. Public render reads the JSON + applies the colors + loads the Google Fonts (per DD-5.3 path b — full picker; or path a — preset-only with no Google Fonts integration).

5. **Per-location mini-websites for a clinic chain.** Enhanced Wellness has 3 locations: Bangalore (HSR Layout), Mumbai (Bandra), Hyderabad (Banjara Hills). Owner creates 3 MiniWebsiteConfig rows — one per Location. Each row has its own slug (`enhanced-wellness-bangalore`, `enhanced-wellness-mumbai`, `enhanced-wellness-hyderabad`), distinct hero copy, distinct contact phone, distinct featured-service order. Public visitor to `/m/enhanced-wellness-bangalore` sees Bangalore-specific content; visitor to `/m/enhanced-wellness-mumbai` sees Mumbai-specific. Per `Location.id` FK on MiniWebsiteConfig per DD-5.2.

6. **Operator runs an A/B test on hero copy via draft / publish toggle (Phase 3).** Out of scope for v1 (Q below) but the draft/publish flow is the foundation: owner saves a new draft with a different hero subtitle; previews it; reverts to the prior draft if it underperforms. Phase 3 layers analytics + traffic split on top.

---

## §3 Functional requirements

### FR-3.1 NEW Prisma model `MiniWebsiteConfig` (sibling to `BookingPage`; per DD-5.1 path b)

Per DD-5.1 path (b) — sibling model — the existing `BookingPage` Wave-7D mini-website columns are MIGRATED to the new model (preserved via back-compat read-through; see FR-3.10) and the new model carries the full mini-website-config shape:

```prisma
model MiniWebsiteConfig {
  id                    Int           @id @default(autoincrement())
  tenantId              Int           @default(1)
  tenant                Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  locationId            Int?                                          // per-location scope (DD-5.2); NULL = tenant-wide single site
  location              Location?     @relation(fields: [locationId], references: [id], onDelete: SetNull)
  bookingPageId         Int?          @unique                         // optional back-compat link to the BookingPage row this was migrated from
  bookingPage           BookingPage?  @relation(fields: [bookingPageId], references: [id], onDelete: SetNull)
  slug                  String                                        // per-tenant-unique; format token = kebab-case of clinic+location name
  logoUrlsJson          String?       @db.Text                        // JSON-string {"favicon": "/uploads/.../logo-64.png", "header": "...200x80.png", "large": "...400x160.png"}
  heroImageUrlsJson     String?       @db.Text                        // JSON-string {"desktop": "/uploads/.../hero-1920x600.jpg", "mobile": "...960x300.jpg", "og": "...1200x630.jpg"}
  heroHeadline          String?                                       // ≤100 chars; route validates
  heroSubheadline       String?       @db.Text                        // ≤300 chars; route validates
  heroCtaText           String?                                       // optional CTA button label (e.g. "Book Now")
  heroCtaTarget         String?                                       // URL or anchor (e.g. "#book" or "/book/<slug>")
  themeJson             String?       @db.Text                        // JSON-string {"preset": "MODERN" | "CLASSIC" | "BOLD" | "SPA", "primaryColor": "#265855", "accentColor": "#CD9481", "bgColor": "#FFF8F0", "fontHeading": "Lora", "fontBody": "Inter"}
  contactInfoJson       String?       @db.Text                        // JSON-string {phone, email, addressStreet, addressCity, addressPincode, addressState, addressCountry, mapUrl}
  hoursJson             String?       @db.Text                        // JSON-string {mon: "9:00-19:00", tue: "9:00-19:00", ..., sun: "closed"}
  customCss             String?       @db.Text                        // power-user raw CSS; sanitized via sanitizeHtml on save (DD-5.3 / Q7)
  seoMetaJson           String?       @db.Text                        // JSON-string {metaTitle, metaDescription, ogTitle, ogDescription, ogImageUrl, sitemapPriority}
  published             Boolean       @default(false)                 // draft = false; live = true
  publishedAt           DateTime?                                     // populated when published flips to true
  archivedAt            DateTime?                                     // for soft-delete; renders 404 if non-null
  createdAt             DateTime      @default(now())
  updatedAt             DateTime      @updatedAt

  featuredServices      MiniWebsiteServiceFeatured[]

  @@unique([tenantId, slug])
  @@unique([locationId])                                              // one mini-website per location (locationId NULL = one tenant-wide)
  @@index([tenantId, published])
}
```

**Auth:** all admin routes require `verifyToken` + `tenantWhere()` scope; mutations require `ADMIN` (configure) or `MANAGER` (edit hero/services per FR-3.9).

### FR-3.2 NEW Prisma model `MiniWebsiteServiceFeatured` (drag-to-reorder + publicVisible toggle)

```prisma
model MiniWebsiteServiceFeatured {
  id                    Int           @id @default(autoincrement())
  tenantId              Int           @default(1)
  tenant                Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  miniWebsiteConfigId   Int
  miniWebsiteConfig     MiniWebsiteConfig @relation(fields: [miniWebsiteConfigId], references: [id], onDelete: Cascade)
  serviceId             Int
  service               Service       @relation(fields: [serviceId], references: [id], onDelete: Cascade)
  position              Int           @default(0)                     // 0-indexed; ORDER BY position ASC for render
  publicVisible         Boolean       @default(true)                  // toggle to hide a service from the public site
  isPrimary             Boolean       @default(false)                 // "star" the primary service
  createdAt             DateTime      @default(now())
  updatedAt             DateTime      @updatedAt

  @@unique([miniWebsiteConfigId, serviceId])
  @@unique([miniWebsiteConfigId, position])                           // no duplicate positions
  @@index([tenantId, miniWebsiteConfigId])
  @@index([tenantId, serviceId])
}
```

### FR-3.3 Admin editor page: `frontend/src/pages/wellness/MiniWebsiteEditor.jsx`

Mounted under the wellness sidebar at `/wellness/mini-website` (or under Settings at `/settings/mini-website` per Q1). Single-page editor with N tabs:

- **Branding tab** — logo upload zone (drag-drop + click-to-pick) + hero image upload + hero headline (max 100 chars input) + hero subheadline (max 300 chars textarea) + hero CTA text + hero CTA target.
- **Services tab** — list of all the tenant's Services; drag-to-reorder via `react-beautiful-dnd` or HTML5 native (DD-5.3 / Q3); toggle PUBLIC-VISIBLE per service; "Mark as primary" star icon on the first service.
- **Contact tab** — phone + email + address fields (street + city + pincode + state + country) + map URL or embedded Google Maps iframe + business hours (per-weekday open/close time pickers).
- **Theme tab** — preset palette picker (4 presets: Modern / Classic / Bold / Spa) + font dropdown (Inter / Lora / Poppins / Merriweather per DD-5.3) + optional accent color override via `<input type=color>` + dark-mode toggle (Phase 2).
- **SEO tab** — meta title input + meta description textarea + open-graph image picker (defaults to hero image; can be overridden) + sitemap priority dropdown.
- **Custom CSS tab (ADMIN-only; gated)** — power-user raw CSS textarea; sanitized via `sanitizeHtml` on save; preview shows the rendered effect.
- **Preview button** — opens `/m/<slug>?preview=1` in a new tab; renders draft state.
- **Save Draft button** — writes the row WITHOUT flipping `published=true`; audit `MINI_WEBSITE_DRAFT_SAVED`.
- **Publish button** — flips `published=true` + `publishedAt=now()`; audit `MINI_WEBSITE_PUBLISHED`.
- **Unpublish button** — flips `published=false` (keeps the row; public slug renders 404); audit `MINI_WEBSITE_UNPUBLISHED`.

Per-location switcher at the top of the page (dropdown of Locations) — operator picks which location's mini-website they're editing (only visible if Tenant has >1 Location).

### FR-3.4 Public render page: `frontend/src/pages/public/MiniWebsite.jsx`

Mounted at `/m/:slug` (or `/<tenantSlug>/<locationSlug>` per Q1). No auth (public). Reads from `GET /api/public/mini-website/:slug` (FR-3.6). Renders:

- Hero block — logo + hero image + headline + subheadline + CTA button → linking to `/book/:slug` (the existing PublicBooking flow).
- Services block — featured services (rendered in `position` order; only `publicVisible=true`); each service card has name + duration + price + "Book" button.
- Contact block — phone (click-to-call) + email (mailto) + address + map embed + business hours table.
- Theme — primary color + accent color + font applied via inline `<style>` block or CSS variables on the body.
- Custom CSS — applied via `<style>` block (sanitized).
- Footer — "Powered by Globussoft CRM" attribution; opt-out via tenant config (Phase 2).
- SEO — `<title>` + `<meta name=description>` + `<meta property=og:*>` populated from `seoMetaJson`.
- Server-side render OR React-SSR (DD-5.5) — first-paint < 1s; SEO-indexable.

### FR-3.5 Image upload + processing

Existing `/api/booking-pages/:id/upload` Multer endpoint is REPLACED with a richer mini-website-specific upload at `/api/wellness/mini-website/:id/upload` (the booking-page upload remains for non-mini-website use cases, but the mini-website surface uses the new endpoint for the multi-size resize logic).

Server-side resize via `sharp` (existing dependency):

- **Logo upload** — accepts PNG/JPG/SVG up to 5 MB; generates 3 sizes: favicon 64×64, header 200×80, large 400×160. URLs stored in `MiniWebsiteConfig.logoUrlsJson` as `{favicon, header, large}` map.
- **Hero image upload** — accepts JPG/PNG up to 10 MB; crops + resizes to 1920×600 (desktop), 960×300 (mobile), 1200×630 (open-graph). URLs stored in `MiniWebsiteConfig.heroImageUrlsJson`.
- **Storage backend** — local-disk default (under `/uploads/mini-website/<tenantId>/<locationId>/...`); S3-pluggable via `MINI_WEBSITE_STORAGE=local|s3` env var per DD-5.4 (similar pattern to `EMPLOYEE_DOC_STORAGE` per PRD_STAFF_DETAIL D15 DD-5.4).
- **MIME allowlist** — `image/png` + `image/jpeg` + `image/svg+xml` for logo only (SVG security risks per Q7); enforced via `multer.fileFilter`.
- **Audit** — `MINI_WEBSITE_IMAGE_UPLOADED { kind: 'LOGO' | 'HERO', sizesGenerated: [...], fileSizeBytes }`.

### FR-3.6 Backend routes

New routes under `/api/wellness/mini-website` (admin) + `/api/public/mini-website` (public, no auth):

- `GET /api/wellness/mini-website` — list (admin; filters: locationId, published)
- `GET /api/wellness/mini-website/:id` — detail (admin; embeds `featuredServices` join + Service info)
- `POST /api/wellness/mini-website` — create (operator: locationId nullable; slug auto-generated from clinic-name kebab-case on first save; operator can override)
- `PUT /api/wellness/mini-website/:id` — update fields (theme, contact, hero, SEO, etc.)
- `POST /api/wellness/mini-website/:id/upload` — image upload (logo or hero; ?kind=LOGO|HERO body param)
- `POST /api/wellness/mini-website/:id/services` — bulk-set featuredServices (body: array of {serviceId, position, publicVisible, isPrimary})
- `POST /api/wellness/mini-website/:id/publish` — flip `published=true`
- `POST /api/wellness/mini-website/:id/unpublish` — flip `published=false`
- `DELETE /api/wellness/mini-website/:id` — soft-delete (sets `archivedAt`; ADMIN-only)
- `GET /api/public/mini-website/:slug` — public read; returns full config + active publicVisible services; cached for 5 min server-side
- `GET /api/public/mini-website/:slug?preview=1` — preview mode; returns draft state (auth via short-lived JWT preview token from admin "Preview" button)

**Idempotency:** all POST endpoints accept `Idempotency-Key` header per `lib/idempotency.js`.

### FR-3.7 Image processing details

```javascript
// pseudocode for the upload handler
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

router.post('/:id/upload', verifyToken, verifyRole(['ADMIN', 'MANAGER']),
  multerInstance.single('file'), async (req, res) => {
  const { id } = req.params;
  const { kind } = req.body; // 'LOGO' | 'HERO'
  // ... tenant scope check ...
  const sizes = kind === 'LOGO'
    ? [{ w: 64, h: 64, name: 'favicon' }, { w: 200, h: 80, name: 'header' }, { w: 400, h: 160, name: 'large' }]
    : [{ w: 1920, h: 600, name: 'desktop' }, { w: 960, h: 300, name: 'mobile' }, { w: 1200, h: 630, name: 'og' }];
  const urls = {};
  for (const sz of sizes) {
    const filename = `${kind.toLowerCase()}-${sz.name}-${Date.now()}.png`;
    const outPath = path.join('/uploads/mini-website', String(req.user.tenantId), id, filename);
    await sharp(req.file.buffer)
      .resize(sz.w, sz.h, { fit: 'cover' })
      .toFile(outPath);
    urls[sz.name] = outPath.replace(/^\/uploads/, '/uploads');
  }
  await prisma.miniWebsiteConfig.update({
    where: { id: parseInt(id) },
    data: kind === 'LOGO'
      ? { logoUrlsJson: JSON.stringify(urls) }
      : { heroImageUrlsJson: JSON.stringify(urls) },
  });
  await writeAudit({ entity: 'MINI_WEBSITE', entityId: id, action: 'IMAGE_UPLOADED', meta: { kind, sizes } });
  res.json({ urls });
});
```

### FR-3.8 Audit log: `MINI_WEBSITE_*` events

New event vocab (additive; entity = `MINI_WEBSITE`):

- `MINI_WEBSITE_CONFIGURED` — emitted on POST /mini-website (config row created)
- `MINI_WEBSITE_UPDATED` — emitted on PUT /mini-website/:id
- `MINI_WEBSITE_PUBLISHED` — emitted on POST /publish
- `MINI_WEBSITE_UNPUBLISHED` — emitted on POST /unpublish
- `MINI_WEBSITE_DRAFT_SAVED` — emitted on PUT when published=false (operator explicitly saving a draft)
- `MINI_WEBSITE_IMAGE_UPLOADED` — emitted on POST /:id/upload
- `MINI_WEBSITE_SERVICES_REORDERED` — emitted on POST /:id/services
- `MINI_WEBSITE_ARCHIVED` — emitted on DELETE
- `MINI_WEBSITE_VIEWED` — emitted on GET /api/public/mini-website/:slug (sampled at 1% to avoid log bloat per Q10)

### FR-3.9 RBAC matrix

- **ADMIN** — configures (POST + DELETE); edits all tabs; publish/unpublish.
- **MANAGER** — edits Branding + Services + Contact + Theme tabs; can publish/unpublish; CANNOT delete or edit Custom CSS (security risk per Q7).
- **USER (any wellnessRole)** — read-only access to the mini-website editor (can preview but not save).
- **Cashier sub-role + non-wellness USER** — no access (sidebar entry hidden).

### FR-3.10 Back-compat for Wave-7D BookingPage rows

For Wave-7D-era tenants that already populated the Wave-7D mini-website fields on `BookingPage`:

1. One-shot migration script `backend/scripts/migrate-bookingpage-to-mini-website.js`:
   ```
   for each BookingPage where logoUrl IS NOT NULL OR heroImageUrl IS NOT NULL OR heroHeadline IS NOT NULL OR featuredServiceIds IS NOT NULL:
     create MiniWebsiteConfig row with bookingPageId=<BookingPage.id>, slug=<BookingPage.slug>,
       logoUrlsJson={"large": <BookingPage.logoUrl>} (single-size legacy; new uploads add the other 2 sizes),
       heroImageUrlsJson={"desktop": <BookingPage.heroImageUrl>},
       heroHeadline=<BookingPage.heroHeadline>, heroSubheadline=<BookingPage.heroSubheadline>,
       contactInfoJson=JSON.stringify({phone: <BookingPage.contactPhone>, email: <BookingPage.contactEmail>}),
       hoursJson=<BookingPage.hoursJson>,
       published=true (legacy rows were always live);
     parse featuredServiceIds CSV and create MiniWebsiteServiceFeatured rows;
     emit audit MIGRATED_FROM_BOOKINGPAGE.
   ```
2. The BookingPage row STAYS — booking flow continues to work against it; the Wave-7D fields on BookingPage become deprecated (logged but readable; new updates write to MiniWebsiteConfig).
3. Admin route `POST /api/wellness/mini-website/migrate-from-bookingpages` (ADMIN-only; per `adding-admin-trigger-endpoint` skill) lets operator manually trigger migration if the one-shot script hasn't run.

### FR-3.11 Slug uniqueness + auto-generation

On first save (POST /mini-website):
- If `slug` body param provided: validate `kebab-case` (regex `^[a-z0-9-]{1,50}$`); reject 400 on invalid.
- If `slug` not provided: auto-generate from `Tenant.name + '-' + Location.name` (kebab-case, lowercased, special chars stripped). Example: `enhanced-wellness-bangalore`.
- `@@unique([tenantId, slug])` constraint enforces uniqueness within the tenant.
- Operator can override with a manual slug (e.g. `bangalore-wellness-hub`).

---

## §4 Non-functional

- **Per-tenant + per-location scoping** — every query carries `tenantId` filter (enforced by global guard + per-route `tenantWhere()` helper); per-location queries add `locationId` filter; the unique constraint `@@unique([tenantId, slug])` enforces uniqueness within the tenant; `@@unique([locationId])` enforces one-mini-website-per-location (or one tenant-wide if locationId IS NULL).
- **Image processing on upload** — server-side resize via `sharp`; generates 3 sizes per logo + 3 sizes per hero image; stored under `/uploads/mini-website/<tenantId>/<locationId>/...`; mirrors existing wellness photo-upload pattern.
- **Public render performance** — server-side HTML pre-render OR React-SSR (per DD-5.5); cache `slug→config` for 5 min in Redis or in-process LRU; first-paint < 1s on a 3G mobile connection.
- **SEO surface** — each mini-website renders meta tags + open-graph tags from `seoMetaJson`; the `<title>` + `<meta name=description>` + `<meta property=og:title>` + `<meta property=og:description>` + `<meta property=og:image>` + `<link rel=canonical>` are populated server-side. Phase 2 ships per-mini-website sitemap entry at `/sitemap.xml`.
- **Mobile responsive** — the public render must work on phone-sized screens (320px wide minimum); inherits the existing wellness theme's `prefers-color-scheme` + mobile-first CSS pattern.
- **Cache invalidation on publish** — POST /publish invalidates the 5-min cache for that slug; PUT updates while published=false do NOT trigger cache invalidation (draft state).
- **Idempotency on POST endpoints** — `Idempotency-Key` header per `lib/idempotency.js`; cache TTL = 24h.
- **Custom CSS sanitization** — `sanitizeHtml` strips `<script>` + `<iframe>` + `<style>` + `<link>` + JavaScript URL refs; only CSS rules allowed; preview-before-save UX shows the operator the sanitized version (per Q7).
- **Audit log durability** — `MINI_WEBSITE_*` events flow through `writeAudit()`; participate in the tamper-evident hash-chain; `/api/audit/verify` accepts the new vocab without code change.
- **Storage growth** — each mini-website with full uploads = ~2 MB (logo 3 sizes + hero 3 sizes); 100 tenants × 3 locations = 600 mini-websites × 2 MB = ~1.2 GB on disk. Acceptable for the demo box; flag S3-migration trigger at 10 GB.

---

## §5 Hand-over reqs / cred chase / design decisions / vendor docs

### Design decisions (DD)

- **DD-5.1: schema shape — extend `BookingPage` (path a) vs new sibling `MiniWebsiteConfig` (path b).** Two paths:
  - **(a) Extend existing `BookingPage` model** with the missing columns (`themeJson` + `locationId` + `published` + `publishedAt` + `archivedAt` + `customCss` + `seoMetaJson`) + promote `featuredServiceIds` CSV to a proper `MiniWebsiteServiceFeatured` join table. Pros: no migration of Wave-7D data; single source of truth. Cons: bloats `BookingPage` (mixed concerns: booking config + mini-website config); the row's purpose becomes ambiguous; `BookingPage.slug` is shared with both flows so the mini-website slug IS the booking-page slug (limiting flexibility).
  - **(b) NEW sibling `MiniWebsiteConfig` model** with `bookingPageId Int? @unique` back-reference. Mini-website lives separately; the BookingPage stays focused on booking flow; the migration moves Wave-7D field data into MiniWebsiteConfig (back-compat: BookingPage's Wave-7D fields stay readable via a thin shim for ~30d).
  - **Recommend (b)** for v1. Clean separation of concerns; the mini-website is a distinct surface from booking flow; per-location scoping is more natural; the migration script is small (~30 LOC); back-compat is achievable in 30d.

- **DD-5.2: per-tenant vs per-location scope.** Two paths:
  - **(a) Per-tenant (one mini-website per tenant)** — `MiniWebsiteConfig.locationId` is omitted; one row per Tenant. Multi-location chains share one mini-website (URL = tenant-wide). Pros: simpler; matches today's BookingPage shape.
  - **(b) Per-location (one mini-website per Location; locationId nullable for tenant-wide)** — current proposal. Each Location can have a distinct mini-website (distinct hero copy, distinct slug). `locationId IS NULL` row = tenant-wide fallback (used when no Locations exist).
  - **Recommend (b)** for v1. Multi-location clinic chains (Enhanced Wellness Bangalore/Mumbai/Hyderabad — the canonical wellness tenant — has 3 Location rows already) need distinct mini-websites; the per-location scope is the operator workflow Zylu ships; the implementation cost is one nullable FK + one composite unique index.

- **DD-5.3: theme depth — preset palette only (path a) vs preset + accent override (path b) vs full color picker + Google Fonts (path c).** Three paths:
  - **(a) Fixed 4 presets, fixed font list (Inter / Lora / Poppins / Merriweather)** — operator picks one preset + one font; no customization. Pros: cheapest implementation (~30 LOC); designer-approved color palettes; no risk of operator picking unreadable color combinations.
  - **(b) 4 presets + accent color override + font dropdown** (current proposal). Operator picks a preset + can override the accent color via `<input type=color>` + picks a font. Adds ~50 LOC; minor risk of bad color combinations (mitigated via contrast-check on save — see Q11).
  - **(c) Full color picker + Google Fonts integration (~200+ fonts)** — operator can pick any color + any font. Pros: maximum flexibility. Cons: significantly more complex; Google Fonts loading impacts page perf; many fonts overlap.
  - **Recommend (b)** for v1. Preset + accent override is the operator workflow Zylu ships; Phase 2 layers (c) if operator demand warrants it.

- **DD-5.4: image storage backend — local-disk (path a) vs S3-pluggable (path b).** Two paths:
  - **(a) Local-disk only** — uploads stored under `/uploads/mini-website/<tenantId>/<locationId>/...`; served by Nginx. Pros: simpler; matches today's `/uploads/booking-pages/` pattern.
  - **(b) Pluggable via env var `MINI_WEBSITE_STORAGE=local|s3`** (current proposal) — local-disk default; S3 opt-in per tenant. Mirrors `PRD_STAFF_DETAIL.md` D15 DD-5.4 pattern.
  - **Recommend (b)** for v1. Local-disk is the v1 default (works on the demo box without S3 credentials); S3 is opt-in for production deployments at scale (>10 GB of mini-website assets).

- **DD-5.5: public render layer — server-side HTML rendering (path a) vs React-SSR via Next.js-style (path b) vs client-side React (path c).** Three paths:
  - **(a) Server-side HTML rendering** — backend renders a static HTML page from the config; minimal JS on the public page. Pros: best first-paint perf; SEO-optimal; simplest. Cons: limited interactivity (drag-to-book interactions require client-side JS).
  - **(b) React-SSR via Next.js or similar** — public page is a React component server-rendered then hydrated. Pros: rich interactivity (the "Book Now" CTA can prefetch the booking-flow data); SEO-optimal. Cons: heavier deployment surface (Next.js or `react-dom/server` setup); the CRM today has no SSR infra.
  - **(c) Client-side React-only** — public page is a SPA. Pros: matches the existing wellness public-booking pattern. Cons: SEO-poor (search engines see an empty `<div id=root>`); slower first-paint; bad for social-share open-graph previews (some crawlers don't execute JS).
  - **Recommend (a)** for v1. Server-side HTML rendering is the cleanest SEO + perf path; the public mini-website is largely static (no need for SPA interactivity); the booking CTA links to the existing PublicBooking.jsx SPA flow at `/book/<slug>`. Use a small template engine (Handlebars or string interpolation; no Next.js required). Phase 2 can upgrade to React-SSR if richer interactivity is needed.

- **DD-5.6: SEO surface depth — meta tags only (path a) vs meta tags + sitemap (path b) vs meta tags + sitemap + structured JSON-LD (path c).** Three paths:
  - **(a) Meta tags + open-graph only** — `<title>` + `<meta name=description>` + `<meta property=og:*>` populated from `seoMetaJson`. No sitemap. No structured data.
  - **(b) Meta tags + sitemap** — adds `/sitemap.xml` with per-mini-website entries. Better search-engine indexability for multi-location tenants.
  - **(c) Meta tags + sitemap + JSON-LD structured data** — adds schema.org `LocalBusiness` JSON-LD block (with operating hours, address, phone, services) for rich search results. Best-in-class SEO.
  - **Recommend (a)** for v1. Meta tags + open-graph covers 80% of SEO + social-share preview value; sitemap is Phase 2 (~0.25 day); JSON-LD is Phase 3 (deeper schema mapping; ~1 day).

- **DD-5.7: publish workflow shape — single-state (path a) vs draft/published (path b) vs draft/scheduled/published (path c).** Three paths:
  - **(a) Single-state** — saved = live. Operator hits Save → public site renders new copy immediately. Pros: simplest.
  - **(b) Draft / published** (current proposal) — operator saves as draft; clicks Publish to expose. Audit `MINI_WEBSITE_PUBLISHED` separately. Pros: matches Zylu reference; safer for operator (preview before publish).
  - **(c) Draft / scheduled / published** — operator can schedule a publish-at-future-time (e.g. for a marketing campaign launch). Adds a cron-triggered "publish-on-schedule" engine. Phase 2.
  - **Recommend (b)** for v1. Draft/published is the operator workflow Zylu ships; the implementation cost is one boolean column + one route endpoint + one audit event. Phase 2 layers (c).

- **DD-5.8: drag-to-reorder UI library — `react-beautiful-dnd` (path a) vs HTML5 native drag-and-drop (path b) vs `dnd-kit` (path c).** Three paths:
  - **(a) react-beautiful-dnd** — popular, well-supported, good touch support. Atlassian-maintained but de-prioritized; last release 2022.
  - **(b) HTML5 native** — zero dependencies; works in all modern browsers. Drawback: clunky on mobile / touch (mobile drag-drop is notoriously bad in HTML5 native).
  - **(c) dnd-kit** — modern (2024+), TypeScript-first, touch-friendly, smaller bundle than react-beautiful-dnd. Active maintenance.
  - **Recommend (c)** for v1 — dnd-kit; smaller bundle; better touch handling for tablet operators; active maintenance. If existing frontend has react-beautiful-dnd already, reuse that (TBD by frontend audit).

### Cred chase

None for v1 — pure schema + routes + admin-page + public-render work. No third-party credentials required.

If Google Fonts integration is opted into per DD-5.3 path (c) — no creds, but adds `https://fonts.googleapis.com` to the CSP allowlist. Phase 2 only.

### Vendor docs

- Prisma `@@unique` composite-index docs — [https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#unique-1](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#unique-1)
- `sharp` image-resize docs — [https://sharp.pixelplumbing.com/](https://sharp.pixelplumbing.com/) (already in use via wellness photo-upload pattern)
- `multer` file-upload docs — [https://github.com/expressjs/multer](https://github.com/expressjs/multer) (already in use)
- `dnd-kit` docs — [https://dndkit.com/](https://dndkit.com/) (new dependency for v1 frontend; ~50 KB gzipped)
- `sanitize-html` docs — [https://www.npmjs.com/package/sanitize-html](https://www.npmjs.com/package/sanitize-html) (already in use via `middleware/security.js`)
- Open Graph protocol — [https://ogp.me/](https://ogp.me/) (for the SEO meta-tag shape)
- Schema.org `LocalBusiness` — [https://schema.org/LocalBusiness](https://schema.org/LocalBusiness) (Phase 3 JSON-LD per DD-5.6 path c)

---

## §6 Acceptance criteria

1. **Logo + hero upload + persistence + multi-size resize.** Owner uploads a 2 MB PNG logo via the Branding tab; backend generates 3 sizes (favicon 64×64, header 200×80, large 400×160); URLs stored in `MiniWebsiteConfig.logoUrlsJson`; the admin editor shows all 3 sizes as previews. Hero image upload (5 MB JPG) generates 3 sizes (1920×600 / 960×300 / 1200×630). Audit `MINI_WEBSITE_IMAGE_UPLOADED` event for each upload.

2. **Service drag-to-reorder + publicVisible toggle persistence.** Owner drags 3 of 5 services to a new order; toggles 2 services to publicVisible=false. Backend writes `MiniWebsiteServiceFeatured` rows with the new `position` + `publicVisible`. Public render at `GET /api/public/mini-website/:slug` returns only the 3 visible services in the new order. Audit `MINI_WEBSITE_SERVICES_REORDERED` written.

3. **Per-location distinct mini-websites.** Tenant has 3 Location rows (Bangalore, Mumbai, Hyderabad). Owner creates 3 `MiniWebsiteConfig` rows, one per Location. Each row has a distinct slug (`enhanced-wellness-bangalore` / `-mumbai` / `-hyderabad`). Public GET against each slug returns the correct per-location config (correct hero copy, correct featured services, correct contact phone). The `@@unique([locationId])` constraint enforces one-per-location at the database level.

4. **Draft / publish workflow + cache invalidation.** Owner edits hero subhead on a published mini-website; saves as draft (no `Publish` click). Public `GET /api/public/mini-website/:slug` returns the OLD subhead (still cached / draft not published). Owner clicks Publish — cache invalidates; public GET now returns the new subhead. Audit `MINI_WEBSITE_DRAFT_SAVED` + `_PUBLISHED` events written in correct sequence.

5. **Back-compat for Wave-7D BookingPage rows.** Seed a wellness tenant with BookingPage rows that have Wave-7D fields populated (logoUrl + heroHeadline + featuredServiceIds CSV). Run `POST /api/wellness/mini-website/migrate-from-bookingpages` (ADMIN-only). Verify N `MiniWebsiteConfig` rows are created with bookingPageId FK back; verify `MiniWebsiteServiceFeatured` rows match the parsed CSV; verify re-running the migration is idempotent (no duplicate `MiniWebsiteConfig` rows; `@@unique([bookingPageId])` enforces it).

---

## §7 Out of scope

- **Booking widget embed code generator.** Per #809's title "MINI WEBSITE + ONLINE BOOKING WIDGET" — the embed-code (`<iframe src="...">`) for third-party-site embedding of the booking flow is OUT for v1. Phase 2 — already partially scaffolded via `frontend/public/embed/widget.js` per CLAUDE.md v3.1 wellness vertical notes.
- **Multi-language mini-websites.** Operator-served public page in multiple languages (English + Hindi + Kannada). Out for v1. Phase 2 — would require per-language config rows + i18n routing.
- **A/B testing different hero copy.** Operator runs an experiment: 50% of traffic sees Hero A, 50% sees Hero B. Out for v1. Phase 3 — requires analytics + traffic-split infra.
- **Operator-uploadable HTML pages.** Operator pastes raw HTML for full custom page. Out (security risk; structured editor + sanitized custom-CSS only).
- **CDN integration / asset versioning.** Operator's logo/hero images served via CDN with cache-busting. Out for v1; v1 serves from `/uploads/...` directly. Phase 2 — pluggable per DD-5.4.
- **Operator analytics dashboard for mini-website traffic.** "X visitors today; Y clicked Book; Z bounced." Out for v1. Phase 2 — wires into the existing `WebVisitor` + `Touchpoint` models per CLAUDE.md.
- **Custom domain pointing.** Operator's mini-website at `https://enhanced-wellness.com` instead of `/m/enhanced-wellness-bangalore`. Out (requires DNS / CNAME / SSL cert provisioning at the Nginx layer; Phase 3).
- **Theme dark-mode toggle on the public page.** Phase 2.
- **Service category grouping on the public page.** Today services are a flat list; operator wants to group by category (Hair / Skin / Body). Phase 2.

---

## §8 Dependencies

- **Existing `BookingPage` model** at [backend/prisma/schema.prisma:2207-2236](../backend/prisma/schema.prisma#L2207-L2236) — `MiniWebsiteConfig.bookingPageId Int? @unique` FK back per DD-5.1 path (b); back-compat migration script reads Wave-7D fields from here.
- **Existing `Service` model** at [backend/prisma/schema.prisma:3147-...](../backend/prisma/schema.prisma#L3147) — `MiniWebsiteServiceFeatured.serviceId Int` FK; service ordering is over the Service catalogue.
- **Existing `Location` model** at [backend/prisma/schema.prisma:3052-...](../backend/prisma/schema.prisma#L3052) — `MiniWebsiteConfig.locationId Int?` FK; per-location scope.
- **Existing `Tenant` model** at [backend/prisma/schema.prisma:1-...](../backend/prisma/schema.prisma#L1) — `MiniWebsiteConfig.tenantId Int` FK + tenant-scoped queries.
- **Existing `backend/routes/booking_pages.js:328-352`** — the `/:id/upload` Multer pattern; replicated for mini-website upload at `/api/wellness/mini-website/:id/upload`.
- **Existing `backend/routes/booking_pages.js:355-403`** — the `/public/:slug` shape; replicated/extended for mini-website public read at `/api/public/mini-website/:slug`.
- **Existing `backend/routes/wellness.js` photo-upload pattern** — multi-size `sharp` resize logic copied/extracted for the mini-website logo + hero processing.
- **Existing `backend/lib/audit.js`** `writeAudit()` — `MINI_WEBSITE_*` event family flows through unchanged.
- **Existing `middleware/security.js`** `sanitizeHtml` — used for Custom CSS field per Q7.
- **Existing `backend/lib/idempotency.js`** — `Idempotency-Key` header replay-cache.
- **`sharp` library** — already a dependency per wellness photo-upload pattern.
- **`multer` library** — already a dependency per `routes/booking_pages.js` upload endpoint.
- **NEW `dnd-kit` library** — frontend drag-to-reorder UI per DD-5.8 path (c).
- **`PRD_TRAVEL_PER_SUBBRAND_BRANDING.md`** (existing) — operator-INTERNAL theme system; sibling concern but no direct data-layer dependency.
- **`PRD_STAFF_DETAIL.md`** (D15) — pluggable storage backend pattern per DD-5.4 (`MINI_WEBSITE_STORAGE=local|s3` mirrors `EMPLOYEE_DOC_STORAGE`).
- **`PRD_INTEGRATIONS_HUB.md`** (D11) — Phase 3 mini-website preview + publish action can become a hub card (e.g. "Preview mini-website" as a unified governance surface action).

---

## §9 Open questions

- **Q1: Sidebar nav placement — Settings → Mini Website (path a) vs Wellness → Mini Website (path b) vs both?** Settings is where operator expects configuration; Wellness sidebar is where wellness-vertical-specific items live (matches Patients / Calendar / Reports). Per-location URL pattern: `/m/<slug>` flat OR `/<tenantSlug>/<locationSlug>` hierarchical? Affects URL design + sidebar nav. Recommend Wellness sidebar (consistent with vertical-specific routing) + flat `/m/<slug>` URL (simpler + matches Zylu).

- **Q2: Color theme depth — preset palettes only (Modern / Classic / Bold / Spa per Zylu reference) vs free color picker?** DD-5.3 decision. Recommend preset + accent override (path b).

- **Q3: Drag-to-reorder UI library — react-beautiful-dnd vs HTML5 native vs dnd-kit?** DD-5.8 decision. Recommend dnd-kit (modern, touch-friendly).

- **Q4: Image upload — backend-proxied (path a) vs direct-to-S3 via signed URLs (path b)?** Backend-proxied is simpler (works with local-disk default per DD-5.4); direct-to-S3 is faster + offloads bandwidth from the backend but only works when S3 is the backend. Recommend backend-proxied for v1; opt-into direct-to-S3 in Phase 2 when S3 storage is enabled per tenant.

- **Q5: Domain pointing — customer brings their own domain (CNAME → enhanced-wellness.com) vs only-on-globussoft-subdomain (`/m/<slug>`)?** Affects SSL cert provisioning (Certbot + Nginx); affects support burden (custom-domain setup is non-trivial). Out for v1 per §7; Phase 3 candidate. Confirm not-in-v1.

- **Q6: Service ordering — manual drag-to-reorder OR sort-by-criteria (popularity / price / alphabetical)?** Drag is operator-controlled; sort-by-criteria is automatic + driven by data. Recommend drag-only for v1 (operator wants control over what's featured first); sort-by-criteria is Phase 2 (when data accumulates enough to drive a "popularity" signal).

- **Q7: Custom CSS field — power users want it; security risk?** `sanitize-html` strips `<script>` + `<iframe>` + `<style>` + JS URL refs but accepting raw CSS introduces other risks (CSS-driven phishing via overlaid divs; cookie-extracting CSS attribute selectors in extreme cases). Recommend admin-only access + sanitize on save (current proposal) + Phase 2 add a "preview-the-sanitized-version-before-save" UX. Confirm gate.

- **Q8: Publish-to-public behavior — operator-toggled (path a, current proposal) vs auto-publish-on-save (path b) vs operator-toggled-with-scheduled-publish (path c)?** DD-5.7 decision. Recommend path (b) — draft/published; Phase 2 layers scheduled-publish.

- **Q9: Per-mini-website analytics — out (just rely on the existing WebVisitor + Touchpoint models) OR build a dedicated MiniWebsiteAnalytics surface?** Per-mini-website view counts + click-through-rate to the booking flow. Today's WebVisitor model captures visitor sessions; query overhead is non-trivial. Recommend out for v1 (rely on WebVisitor); Phase 2 — dedicated dashboard.

- **Q10: View-event audit sampling — 1% sampling (current proposal in FR-3.8) vs full audit vs no audit?** A popular tenant could see 10K mini-website views per day → 10K audit rows per day per tenant → significant audit-table bloat. 1% sampling = 100 rows per day → manageable. Confirm 1% (or pick a different sampling rate). Phase 2 — telemetry that doesn't ride on the audit hash-chain (separate `MiniWebsiteView` model) is the cleaner shape.

- **Q11: Color contrast accessibility check — auto-validate the operator's color picks against WCAG AA contrast standards?** When operator picks a primary color, validate that the text-on-primary contrast ratio is ≥4.5 (WCAG AA). Block save if not + show a warning + suggest a darker/lighter alternative. Adds ~30 LOC for the contrast-check helper. Recommend YES for v1 (small effort; significant accessibility win); the wellness vertical's customers include older patients with limited vision.

- **Q12: Mini-website-to-booking handoff — CTA "Book Now" button links to `/book/<slug>` (the existing PublicBooking flow) — confirm this is the right route, OR is a dedicated mini-website-scoped booking surface expected?** Recommend `/book/<slug>` (existing flow); the mini-website is the marketing surface, the booking flow is the conversion surface; reusing the existing PublicBooking page saves significant frontend effort.

---

## §10 Status snapshot

**Status:** NOT STARTED — PRD draft only; design call required to lock DD-5.1 (schema shape — extend BookingPage vs new sibling MiniWebsiteConfig) + DD-5.2 (per-tenant vs per-location scope) + DD-5.3 (theme depth — preset palette vs preset + accent override vs full picker + Google Fonts) + DD-5.4 (image storage — local-disk vs S3-pluggable) + DD-5.5 (public render layer — server-side HTML vs React-SSR vs CSR) + DD-5.6 (SEO depth — meta tags only vs sitemap vs JSON-LD) + DD-5.7 (publish workflow — single vs draft/published vs draft/scheduled/published) + DD-5.8 (drag-to-reorder library — react-beautiful-dnd vs HTML5 native vs dnd-kit) + Q1 (sidebar placement — Settings vs Wellness sidebar; URL pattern flat vs hierarchical) + Q5 (custom domain pointing — confirm out-of-v1) + Q7 (custom CSS field — gate to ADMIN-only) + Q11 (contrast accessibility check — confirm in-v1) before any code lands. **DD-5.1 (schema shape) is the highest-leverage decision** — it determines the entire data-layer shape + the back-compat migration scope + the BookingPage's future role.

**Owner:** TBD per product call. Likely allocation:

- Prisma schema additions (NEW `MiniWebsiteConfig` + `MiniWebsiteServiceFeatured` models + back-compat fields on `BookingPage` deprecation flags) — backend engineer ~0.5 day
- `backend/routes/wellness/mini-website.js` (10 admin endpoints — LIST + DETAIL + CREATE + UPDATE + UPLOAD + SERVICES bulk-set + PUBLISH + UNPUBLISH + DELETE + MIGRATE) — backend engineer ~1.5 days
- `backend/routes/public/mini-website.js` (1 public read endpoint with caching) — backend engineer ~0.5 day
- `backend/scripts/migrate-bookingpage-to-mini-website.js` (one-shot Wave-7D back-compat migration) — backend engineer ~0.5 day + admin trigger endpoint per `adding-admin-trigger-endpoint` skill
- Image processing helper extraction — backend engineer ~0.25 day (extract `sharp` multi-size logic to `backend/lib/imageResizer.js` for re-use)
- `frontend/src/pages/wellness/MiniWebsiteEditor.jsx` (admin editor page with 6 tabs — Branding / Services / Contact / Theme / SEO / Custom CSS + per-location switcher + preview button + publish/unpublish workflow) — frontend engineer ~2.5 days
- `frontend/src/pages/public/MiniWebsite.jsx` (public render — server-rendered HTML per DD-5.5 path a; lightweight client JS for "Book Now" CTA prefetch) — frontend engineer ~1.5 days
- Drag-to-reorder integration — frontend engineer ~0.5 day (using dnd-kit per DD-5.8 path c)
- Sidebar nav entry — frontend engineer ~0.1 day
- Tests (api-spec for 11 endpoints + RBAC matrix + idempotency replay + back-compat migration idempotency + image-upload roundtrip + slug-uniqueness + cache-invalidation-on-publish + vitest for `imageResizer.js`) — backend + frontend engineer ~1.5 days
- Wiring into `coverage.yml` + `deploy.yml` gate-spec lists per `wiring-spec-into-gate` skill — backend engineer ~0.25 day
- Documentation (CHANGELOG.md entry + README.md "At a glance" table refresh + CLAUDE.md schema-notes update for the new models) — backend engineer ~0.25 day

**Total estimated effort post-design: 5-8 engineering days** (schema + admin + public + image processing + back-compat + frontend admin page + frontend public page + tests + wiring + docs — matches the "admin-page-with-image-processing + public-render + back-compat" baseline).

**Sibling PRDs in this cluster:**

- `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape, cluster D8)
- `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment-side integration governance, cluster D9)
- `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops, cluster D10)
- `PRD_INTEGRATIONS_HUB.md` (tick #190 — unified discovery / status / governance surface, cluster D11)
- `PRD_TAG_MASTER.md` (tick #191 — controlled-vocabulary governance, cluster D12)
- `PRD_AI_CHAT_HISTORY.md` (tick #192 — unified AI audit + recall surface, cluster D13)
- `PRD_CUSTOMER_SEGMENTS.md` (tick #193 — saved-filter audience targeting, cluster D14)
- `PRD_STAFF_DETAIL.md` (tick #194 — HR profile extension, cluster D15; pluggable-storage pattern shared per DD-5.4)
- `PRD_WALLET_TOPUP.md` (tick #195 — wallet top-up + bonus + expiry, cluster D16)
- `PRD_POS_NEW_SALE.md` (tick #196 — POS New Sale UI, cluster D17)
- `PRD_POS_POLYMORPHIC_INVOICE.md` (tick #197 — invoice spine, cluster D18)

**Related (but distinct) PRDs:**
- `PRD_TRAVEL_PER_SUBBRAND_BRANDING.md` — operator-INTERNAL theme system for travel sub-brands; different audience + render layer + data model from this PRD.

**Blocks before implementation can start:**

- **DD-5.1 (schema shape — extend BookingPage vs new sibling MiniWebsiteConfig) — HIGHEST LEVERAGE; determines entire data-layer shape + back-compat migration scope + BookingPage's future role**
- DD-5.2 (per-tenant vs per-location scope) — MUST resolve (column nullability + composite-unique index shape)
- DD-5.3 (theme depth — preset vs preset+accent vs full picker) — MUST resolve (admin-page complexity + dependency list — Google Fonts integration if path c)
- DD-5.5 (public render layer — server-side HTML vs React-SSR vs CSR) — MUST resolve (frontend architecture + SEO posture)
- DD-5.7 (publish workflow — single vs draft/published) — MUST resolve (column count + audit event vocab)
- Q1 (sidebar placement + URL pattern) — MUST resolve (frontend routing + sidebar nav)
- Q7 (custom CSS field — gate to ADMIN-only) — MUST resolve (RBAC matrix)
- Q12 (mini-website-to-booking handoff — confirm `/book/<slug>` reuse) — MUST resolve (frontend CTA routing)

**Other DDs / OQs can iterate during implementation.**

**First implementation slice recommendation:**

- **Slice 1** (~1d): Prisma schema additions (NEW `MiniWebsiteConfig` + `MiniWebsiteServiceFeatured` models + nullable Location FK + back-compat fields) + `backend/lib/imageResizer.js` extraction + `backend/routes/wellness/mini-website.js` core CRUD (LIST + DETAIL + CREATE + UPDATE + DELETE) + api-spec tests. Ships the data spine.

- **Slice 2** (~1d): `routes/wellness/mini-website.js` image upload endpoint (POST /:id/upload with multi-size `sharp` resize) + featured-services bulk-set endpoint + `routes/wellness/mini-website.js` publish/unpublish + audit events. Ships the operator-facing mutate surface.

- **Slice 3** (~0.5d): `routes/public/mini-website.js` public read endpoint with 5-min cache + api-spec test (cache invalidation on publish + draft-not-shown-publicly + per-location distinct slugs).

- **Slice 4** (~2.5d): `frontend/src/pages/wellness/MiniWebsiteEditor.jsx` admin editor page with 6 tabs + per-location switcher + preview/publish/unpublish workflow + drag-to-reorder via dnd-kit + sidebar nav entry. Ships the operator-facing UI.

- **Slice 5** (~1.5d): `frontend/src/pages/public/MiniWebsite.jsx` server-rendered public page + SEO meta tags + open-graph + Book Now CTA to existing `/book/<slug>`. Ships the customer-facing render.

- **Slice 6** (~0.5d): `backend/scripts/migrate-bookingpage-to-mini-website.js` one-shot Wave-7D back-compat migration + admin trigger endpoint per `adding-admin-trigger-endpoint` skill + idempotency-by-bookingPageId. Ships the back-compat layer.

- **Slice 7** (~0.5d): Documentation (CHANGELOG.md entry + README.md "At a glance" refresh + CLAUDE.md schema-notes update for the new models + Operator runbook at `docs/runbook-mini-website.md`). Ships the docs.

Slices 1 + 2 + 3 must ship in order (each depends on the prior). Slice 4 + 5 can ship in parallel after slice 3 if dispatched file-disjoint. Slice 6 can ship anytime after slice 1.

**Cluster placement in `MANUAL_CODING_BACKLOG.md`:** This work fits cluster D (the wellness operational session — wellness-vertical-first; the mini-website surface is wellness-customer-facing). Proposal: add a new entry **D19. Mini Website page editor (#809)** under cluster D — sibling to D8-D18. Cross-references to D17 (POS New Sale — uses Service catalogue for line-pick; this PRD uses Service for featured-ordering; shared dependency on Service shape) + D11 (Integrations Hub — Phase 3 mini-website preview/publish as hub card) + D15 (Staff Detail — pluggable-storage pattern per DD-5.4 mirrors D15's `EMPLOYEE_DOC_STORAGE` env var pattern; `MINI_WEBSITE_STORAGE=local|s3`).

**Cross-PRD coordination check:** Before implementation starts, confirm:

- `routes/audit.js` `/verify` endpoint accepts the `MINI_WEBSITE_*` event family without code change (entity = `MINI_WEBSITE` per FR-3.8).
- `backend/lib/imageResizer.js` is a clean extraction from existing wellness photo-upload pattern — single helper consumed by both mini-website upload AND the existing wellness PatientPhoto upload (refactor opportunity).
- `backend/scripts/migrate-bookingpage-to-mini-website.js` is idempotent — re-runnable without duplicate `MiniWebsiteConfig` rows; `@@unique([bookingPageId])` enforces it.
- `frontend/src/pages/BookingPages.jsx` — the Wave-7D mini-website sub-modal is SIMPLIFIED (or removed) once the dedicated editor lands; the BookingPages list page returns to booking-flow-CRUD-only.
- The Wave-7D fields on `BookingPage` (`logoUrl` / `heroImageUrl` / `heroHeadline` / `heroSubheadline` / `featuredServiceIds` / `contactPhone` / `contactEmail` / `hoursJson`) become deprecated after migration; the migration script preserves the data into `MiniWebsiteConfig`. Phase 2 sunsets the BookingPage columns (with `[allow-column-drop]` bless marker after the 30d back-compat window).
- The public booking flow at `/book/<slug>` continues to read from `BookingPage` (NOT from `MiniWebsiteConfig`) — the two surfaces remain distinct; the mini-website is the marketing landing, the booking page is the conversion surface.
- The `Service.publicVisible` toggle (per use case 3) — DOES the existing `Service` model already have this column? Audit first. If not, ADD it (one-line schema migration) OR push the toggle into `MiniWebsiteServiceFeatured.publicVisible` only (per-mini-website scope; the same Service can be visible on one mini-website and hidden on another) — recommend the latter (matches the current model proposal).
- The `Location` model — confirm `Location.name` is available for the slug auto-generation per FR-3.11.
- The existing `frontend/src/pages/wellness/PublicBooking.jsx` continues to work unchanged; the mini-website's CTA links to it via `/book/<slug>` per Q12.

# PRD — Per-Sub-Brand Branding (Travel CRM)

**Status:** DRAFT • **Owner:** Travel vertical squad • **Filed:** 2026-05-23 (tick #23)
**Refs:** GH #911 (P3 Travel Gap — Per-sub-brand branding) • Travel Stall CRM Roadmap Tier P3 item 16
**Siblings:** [PRD_TRAVEL_B2B_AGENT_PORTAL.md](PRD_TRAVEL_B2B_AGENT_PORTAL.md) (portal consumes brand kit) • [PRD_TRAVEL_BILLING.md](PRD_TRAVEL_BILLING.md) (invoice/voucher PDFs consume brand kit) • [PRD_TRAVEL_QUOTE_BUILDER.md](PRD_TRAVEL_QUOTE_BUILDER.md) (quote PDF + email consume brand kit)

---

## §1 Background + source attribution

The Travel CRM hosts 4 sub-brands under one tenant per Q25 (TMC school trips / RFU Umrah / Travel Stall family holidays / Visa Sure). Each sub-brand has distinct visual identity — TMC ships navy + gold to schools, RFU ships green + Makkah-skyline to Umrah pilgrims, Travel Stall ships warm family-holiday palette, Visa Sure ships customs-cleared / success-rate stamps. Today's `Settings → Branding` page sets ONE logo + ONE brand colour for the whole tenant; PDFs, microsites, emails, and the customer portal all render with that single identity regardless of which sub-brand owns the document. The result: a Travel Stall family-trip invoice prints with TMC navy or vice-versa; pilgrims receive Umrah receipts wearing school-trip imagery.

This PRD scopes moving brand-kit storage from per-tenant to per-sub-brand, plus end-to-end consumption across the 7+ brand surfaces.

### §1.2 Existing infrastructure (do NOT rebuild)

| Asset | Location | Status |
|---|---|---|
| `Tenant.subBrandConfigJson` | `backend/prisma/schema.prisma:170` | Schema slot exists; populated only for WABA/legalEntity/gstin/driveRoot today |
| `backend/lib/subBrandConfig.js` | shipped commit `621aab7` | Per-sub-brand resolver — currently whitelists 5 fields (`wabaId`, `phoneNumberId`, `legalEntityCode`, `gstin`, `driveRootFolderId`); branding fields need adding to `RETURN_FIELDS` |
| `User.subBrandAccess[]` | `schema.prisma:357-359` | Per-user sub-brand allow-list — drives sub-brand context on operator UI |
| `Contact.subBrand` | `schema.prisma:441` | Per-contact sub-brand tag — drives customer-portal context |
| `Deal.subBrand` / `Quote.subBrand` / `Invoice.subBrand` | various | Per-document sub-brand tag — drives PDF/email-render context |
| `requireSubBrandMatch()` middleware | `routes/external.js` neighbours | API-key sub-brand enforcement (proof of pattern) |
| `pdfRenderer.js` | `backend/services/pdfRenderer.js` | Today renders with tenant-wide logo/color; needs sub-brand-aware accept |
| `Tenant.vertical` | `schema.prisma` | Already scopes `data-vertical="travel"` CSS root; brand-kit overrides plug under this scope |
| `frontend/src/components/Sidebar.jsx` | Travel render branch | Already aware of sub-brand context selector (Q25 scaffolding) |

### Travel-vertical gaps (the why)

- **One logo for four brands** — TMC school-trip flyers carry the same logo as Visa Sure visa-receipts; clients flag this as "looks pirated" in roadmap feedback.
- **Color collisions** — generic tenant accent (blue) overrides the Travel-vertical placeholder navy/gold; RFU's Umrah green never reaches the wire.
- **PDF templates ignore brand** — `pdfRenderer.renderInvoice()` reads `tenant.brandingColor` only, never `subBrand`.
- **Email signatures hard-coded** — `emailService.js` appends a single tenant-level signature regardless of which sub-brand operator sent the mail.
- **Customer portal one-size-fits-all** — a Travel Stall customer logging into `/portal` sees TMC-imagery in the hero.
- **Embed widget shows wrong brand** — embedding the TMC lead form on a school's website still shows the tenant's default colour.
- **WABA per-sub-brand already works** — proof-of-pattern from `subBrandConfig.js` shows the resolver scaffolding works; just needs brand-kit-shaped fields.

### Source attribution

- GH #911 ACs: "Move logo, brand colour, email signature, and invoice footer onto the sub-brand record. TMC, RFU, Travel Stall, Visa Sure each render with their own identity on PDFs and microsites. Update PDF templates (Quote, Invoice, Voucher) to read from sub-brand branding. Update microsite renderer to read from sub-brand branding."
- Travel Stall CRM Roadmap Tier P3 item 16.

---

## §2 Use cases

- **UC-2.1** TMC operator generates a school-trip itinerary PDF → PDF renders with TMC navy header + gold accent + TMC mascot logo + TMC school-trip footer disclaimer.
- **UC-2.2** RFU operator emails an Umrah package quote → email header carries RFU green palette + Makkah-skyline banner; signature block uses RFU operator's title + RFU support hotline.
- **UC-2.3** Travel Stall customer logs into `/portal` for their booking → hero image is the warm family-holiday palette + Travel Stall logo + Travel Stall support hotline.
- **UC-2.4** Visa Sure customer receives an invoice PDF → invoice carries the Visa Sure "customs-cleared" stamp + success-rate badge + Visa Sure footer.
- **UC-2.5** Operator switches sub-brand context via sidebar selector → UI accent colors + sidebar pinned-brand-logo + favicon swap within 1 second.
- **UC-2.6** Sub-agent (B2B portal — see sibling PRD) sees their assigned sub-brand's brand kit + B2B-agent-specific portal greeting; cannot see other sub-brand kits.
- **UC-2.7** Admin uploads a new logo for TMC + tweaks TMC's accent — preview pane shows the change live; next operator sub-brand context switch picks up the new kit within 60s cache TTL.

---

## §3 Functional requirements

### FR-3.1 Brand kit schema (per sub-brand)

- **(a)** **Visual assets per sub-brand:** `logoUrl`, `logoDarkUrl`, `faviconUrl`, `wordmarkUrl` (optional), `heroImageUrl` (portal landing).
- **(b)** **Color palette per sub-brand:** `colors.primary`, `colors.accent`, `colors.text`, `colors.background`, `colors.successBadge`, `colors.warningBadge` (all hex strings).
- **(c)** **Typography per sub-brand:** `fonts.heading`, `fonts.body`, `fonts.code` (Google Fonts family names; resolved via DD-5.1).
- **(d)** **Email-render assets:** `email.signatureTemplate` (handlebars template — operator name, title, hotline interpolated), `email.headerImageUrl`, `email.footerText`.
- **(e)** **PDF-render assets:** `pdf.templateId` (one of `default | school_trip | umrah | family_holiday | visa`), `pdf.footerText`, `pdf.invoiceStampUrl`.
- **(f)** **Customer-facing identity:** `tagline`, `missionStatement`, `supportEmail`, `supportPhone`, `socialLinks.{facebook, instagram, twitter, youtube}`.
- **(g)** **PDF print color overrides (CMYK variants):** `print.colors.primary`, `print.colors.accent` (optional, for CMYK-correct invoice printing per OQ-9.4).

### FR-3.2 Admin UI to manage brand kits

- **(a)** Route: `/settings/brand-kits` — admin-only (RBAC `ADMIN`).
- **(b)** Per-sub-brand tabbed panels (TMC / RFU / Travel Stall / Visa Sure) — same 4 known sub-brands as `VALID_SUB_BRANDS`.
- **(c)** Upload widget for logo / logo-dark / favicon / hero / email-header / invoice-stamp (validation in FR-3.5).
- **(d)** Color picker per palette slot — uses native `<input type="color">` with WCAG-AA contrast preview alongside.
- **(e)** Font picker — Google Fonts library autocomplete (Q-BR-1 + DD-5.1).
- **(f)** Live preview pane — 3 thumbnails (operator sidebar, customer portal hero, sample invoice PDF) update on every field change.
- **(g)** "Copy from sub-brand X" mode — admin can clone TMC's kit into RFU then tweak; reduces 4× duplicate data entry.
- **(h)** Version history per sub-brand kit (DD-5.6) — last 10 versions, revert button.

### FR-3.3 Consumer surfaces (end-to-end consumption)

Every surface below MUST resolve current sub-brand context (FR-3.4) and pull from the per-sub-brand brand kit. If the kit is missing a field, fall back to tenant-level default (existing `Tenant.brandingColor` / `Tenant.brandingLogo`).

- **(a)** **Sidebar navigation** — `Sidebar.jsx` Travel branch renders pinned `subBrand.logoUrl` + accent-color border when sub-brand context active.
- **(b)** **CRM operator pages** — accent color (`var(--primary-color)`), button color, link color, badge palette all driven by current sub-brand kit when context active.
- **(c)** **PDF templates** — `pdfRenderer.renderInvoice()`, `.renderQuote()`, `.renderVoucher()`, `.renderItinerary()`, `.renderConsent()` all accept `subBrand` arg + read brand kit.
- **(d)** **Email templates** — `emailService.send()` interpolates `subBrand.email.signatureTemplate`, header image, footer text.
- **(e)** **SMS / WhatsApp templates** — outbound sender display name + WhatsApp business profile picture per sub-brand (resolved via existing `subBrandConfig.js` WABA wiring + new brand-kit fields).
- **(f)** **Customer portal** — `/portal/*` reads sub-brand from session's `Contact.subBrand`, themes the whole portal accordingly.
- **(g)** **Embed widget** — `/embed/widget.js` accepts `subBrand` declared via embed-config param; renders form chrome with that brand kit.
- **(h)** **Public landing pages** — `/book/:slug` reads BookingPage.subBrand, themes per kit.
- **(i)** **Microsites** — `routes/travel_microsites.js` renderer reads sub-brand from microsite record, themes accordingly (GH #911 explicit AC).

### FR-3.4 Sub-brand context detection

- **(a)** **Operator surfaces** — current sub-brand chosen via sidebar selector (existing Q25 scaffolding); stored in operator's session.
- **(b)** **Customer portal** — sub-brand derived from `Contact.subBrand` at session-creation time; per-customer fixed.
- **(c)** **Embed widget** — sub-brand declared via `data-sub-brand="tmc"` HTML attribute on the embed script tag.
- **(d)** **Email send** — sub-brand derived from `Deal.subBrand` / `Invoice.subBrand` / `Contact.subBrand` at send-time (whichever doc is the email's anchor).
- **(e)** **PDF render** — sub-brand passed explicitly by caller (Invoice/Quote/Voucher carry `subBrand` column).
- **(f)** **Fallback** — if no sub-brand resolvable, use `Tenant.defaultSubBrand` (new field, defaults to `tmc` for Travel Stall tenant per Q25).

### FR-3.5 Upload & validation

- **(a)** Logo PNG ≤2MB, max 1024×1024px, square or 4:1 aspect (warn outside).
- **(b)** Favicon ≤100KB, 32×32 / 64×64 / 128×128 ICO or PNG.
- **(c)** Hero image ≤4MB, 1920×800 recommended.
- **(d)** Custom font file (if DD-5.1 = allowed) ≤5MB, WOFF2 / WOFF / TTF.
- **(e)** Color picker emits hex only; WCAG-AA contrast checker warns inline if primary-vs-background contrast <4.5:1.
- **(f)** Server-side re-validation on POST (browser-bypass safety).

---

## §4 Non-functional requirements

- **NFR-4.1** Brand-kit changes propagate within 60s (Redis-backed kit cache TTL = 60s; bust-on-write).
- **NFR-4.2** Admin UI mobile-responsive — admin sometimes tweaks brand kits from a tablet on-site.
- **NFR-4.3** Brand-kit JSON blob (or BrandKit table per DD-5.2) MUST stay <50KB per sub-brand (logo URLs not embedded base64).
- **NFR-4.4** PDF render with brand kit MUST stay <2s p95 (logo + font fetched + cached, not re-downloaded per render).
- **NFR-4.5** Customer-portal first-paint stays <1.5s p95 with brand kit applied (preload critical brand CSS in `<head>`).
- **NFR-4.6** Storage for uploaded assets uses existing tenant file-bucket (`/var/www/uploads/<tenantId>/brand-kits/<subBrand>/`); no new infra.
- **NFR-4.7** Brand-kit asset URLs MUST be served via Nginx-cached static path with 7-day Cache-Control (immutable URLs — re-upload generates new file with hashed name).

---

## §5 Hand-over reqs / cred chase / design decisions

### Design decisions (block implementation start)

- **DD-5.1 Custom font support** — Google Fonts only (faster, free, no licensing exposure) vs custom-font-upload (more flexible but each tenant's licensing legal risk). **Recommendation:** Google Fonts only for v1; revisit if Yasin's brand handover specifies a paid font.
- **DD-5.2 Brand-kit storage shape** — extend `Tenant.subBrandConfigJson` (single JSON blob) vs new `BrandKit` Prisma model (proper columns + version table). **Recommendation:** new `BrandKit` model — version history (FR-3.2.h) + WCAG contrast checking (FR-3.5.e) + per-sub-brand upload audit trails all want proper columns + relations. JSON-blob approach gets unwieldy at ~30 fields per sub-brand × 4 sub-brands × 10 versions = 1200 cells in one blob.
- **DD-5.3 Default brand kits at seed time** — ship 4 starter kits with placeholder colors (TMC navy/gold; RFU green; Travel Stall warm; Visa Sure customs-blue) so the system never renders un-branded, vs require admin to populate. **Recommendation:** ship 4 starter kits via `prisma/seed-travel.js`; admin overrides per-asset.
- **DD-5.4 Logo placement on operator UI** — sidebar header (pinned, ~32px high, always visible) vs top-nav (more prominent but conflicts with current header design). **Recommendation:** sidebar header, with a small top-nav badge showing current sub-brand name + dropdown to switch.
- **DD-5.5 Dark-mode handling** — separate `logoDarkUrl` per sub-brand (admin uploads 2 logos) vs auto-derive from light logo (CSS `filter: invert()`). **Recommendation:** require `logoDarkUrl` for any sub-brand whose light logo doesn't render well inverted (TMC navy-on-white inverts poorly); auto-derive as fallback when missing.
- **DD-5.6 Brand-kit version history** — keep last 10 versions per sub-brand (FR-3.2.h) for revert; older versions hard-purged. Tradeoff: storage growth vs ability to roll back a bad redesign.

### Cred chase / asset chase

- **Q-BR-1** Yasin's brand assets per sub-brand — for each of TMC / RFU / Travel Stall / Visa Sure: logo PNG (light + dark), brand color hex, brand fonts (Google Fonts family or upload), tagline. Overlaps with the existing **Q22 brand assets pending Yasin** placeholder noted in `CLAUDE.md`. **Block:** UI live-preview pane will use placeholders until Yasin's assets arrive.

### Vendor docs

- Google Fonts (free, no key needed; `https://fonts.googleapis.com/css2?family=...`).
- Color picker library — native `<input type="color">` is sufficient for v1; no third-party dep.
- WCAG contrast checker — small custom library (~20 lines, ratio = (L1 + 0.05) / (L2 + 0.05)).
- PDF render — existing `pdfkit` already supports per-render font + color overrides via `doc.font()` / `doc.fillColor()`.

---

## §6 Acceptance criteria

- **AC-6.1** Admin navigates to `/settings/brand-kits` → 4 panels (TMC/RFU/Travel Stall/Visa Sure) visible → admin uploads TMC logo + sets TMC primary color to navy `#122647` + accent gold `#C89A4E` → preview pane re-renders within 1s.
- **AC-6.2** Operator switches active sub-brand context to TMC via sidebar selector → sidebar logo updates to TMC logo + button accent color updates to TMC gold within 1s (no full page reload).
- **AC-6.3** Generate TMC invoice PDF via `POST /api/billing/invoices/:id/pdf` → response PDF carries TMC logo (header) + TMC navy + gold (palette) + TMC footer text. Same call with RFU invoice ID renders Makkah-skyline header + RFU green + RFU footer.
- **AC-6.4** Send email from RFU operator context (sub-brand resolution from `Deal.subBrand="rfu"`) → outbound email header/footer/signature use RFU brand kit (verified via raw MIME inspect on outbound queue).
- **AC-6.5** Customer with `Contact.subBrand="travelstall"` logs into `/portal/login` → portal hero, navigation accent, support-phone footer all use Travel Stall brand kit.
- **AC-6.6** Admin picks an accent color whose contrast against background is <4.5:1 → inline WCAG-AA warning shown; save still allowed but with warning persisted on the kit detail page.
- **AC-6.7** Embed widget on a partner school's site with `data-sub-brand="tmc"` → widget form chrome (header background, button color) renders with TMC brand kit, NOT tenant default.
- **AC-6.8** Admin reverts TMC kit to a prior version → all consumer surfaces re-render with the prior version's assets within 60s (cache TTL).
- **AC-6.9** Microsite for RFU sub-brand renders Umrah palette + RFU logo + RFU support hotline (GH #911 explicit AC).
- **AC-6.10** Operator without `subBrandAccess` for a sub-brand cannot switch context to it (UI selector grayed); API rejects 403 if forced via direct request.

---

## §7 Out of scope

- White-label tenant branding (tenants choosing their own per-tenant brand identity beyond the existing `Tenant.brandingColor`) — separate WL feature, not Travel-specific.
- Animated logos (GIF / Lottie) — flat PNG only for v1.
- Per-rep custom signatures overriding per-sub-brand defaults — covered by existing tenant-wide `User.signature` field; if conflict, per-sub-brand wins.
- A/B-testing brand kits (e.g. test two TMC palettes for conversion) — premium feature, parking.
- Brand-kit translation per language (i18n of tagline / missionStatement) — depends on i18n PRD landing first.
- Auto-generated brand kit from logo color extraction — manual color picker only.

---

## §8 Dependencies

- **`Tenant.subBrandConfigJson`** schema slot (`schema.prisma:170`) — existing, but moving fields to `BrandKit` model per DD-5.2.
- **`backend/lib/subBrandConfig.js`** (commit `621aab7`) — existing resolver; extends with brand-kit resolution helper `resolveBrandKitForSubBrand(tenant, subBrand)`.
- **`backend/services/pdfRenderer.js`** — extend all render methods with `subBrand` arg + brand-kit lookup.
- **`backend/services/emailService.js`** (or equivalent send-time hook) — extend with brand-kit interpolation.
- **`frontend/src/components/Sidebar.jsx`** Travel branch — extend with pinned-brand-logo + accent.
- **`frontend/src/pages/Settings.jsx`** (or new BrandKits.jsx) — new admin UI route.
- **`frontend/src/pages/Portal*.jsx`** — extend with brand-kit theming.
- **`frontend/public/embed/widget.js`** — extend with `subBrand` prop + kit theming.
- **`backend/routes/travel_microsites.js`** — extend microsite renderer with brand-kit lookup.
- **Q22 brand assets pending Yasin** — placeholder kits ship; real assets land later.

---

## §9 Open questions

- **OQ-9.1** Per-sub-brand favicon — does the browser-tab favicon dynamically swap when operator switches sub-brand context, or stay on tenant default? (Dynamic feels right but is a small JS hack on every nav.)
- **OQ-9.2** Multi-tenant: do tenants share a small set of "base" brand-kit templates (presets), or is every tenant fully isolated? (Presets reduce setup time for new tenants; full isolation is simpler.)
- **OQ-9.3** Sub-brand inheritance — should we support a "child sub-brand inherits from parent" pattern for future expansion (e.g. TMC adds a `tmc_premium` sub-brand inheriting TMC + tweaking accent)? (Adds complexity; defer unless concrete need.)
- **OQ-9.4** Print PDFs — brand-kit `colors.primary` is RGB hex (screen). For high-quality printed invoices, do we need separate CMYK values per sub-brand? (Captured in FR-3.1.g as optional.)
- **OQ-9.5** Brand-kit-as-code — JSON export endpoint for version-controlled brand kits (DevOps-friendly), or pure admin-UI-only? (Export is cheap; advocates for export endpoint.)
- **OQ-9.6** Multi-domain support — should each sub-brand have its own customer-portal subdomain (`tmc-portal.tenant.com`, `rfu-portal.tenant.com`) for trust signaling? (Major infra impact; defer to a separate PRD if pursued.)
- **OQ-9.7** Mobile app branding — when the mobile app ships (future), does it consume the same brand-kit JSON over API? (Yes, assume API-first design.)

---

## §10 Status snapshot

### 2026-05-24 update — BrandKit model + CRUD routes shipped (or in-flight)

**Backend schema shipped:** `BrandKit` Prisma model at commit `5060dda` (tick #95, ~52 LOC schema-prisma). Composite key `(tenantId, subBrand, version)` with `@@unique` constraint; `isActive` flag for "one active version per (tenantId, subBrand)" semantics; columns for logo/darkLogo/favicon/colors/font/tagline.

**Backend routes shipping THIS TICK (in-flight by sibling agent):** `backend/routes/brand_kits.js` — CRUD operator surface. POST + PUT atomically demote any prior active row for the same (tenantId, subBrand) when activating a new version (via `prisma.$transaction`).

**Decisions implemented:** DD-5.2 (new BrandKit Prisma model — chose proper-columns approach over JSON-blob extension per the version-history + WCAG-checking + audit-trail rationale).

**What's now possible:**
- Operators can store per-sub-brand brand kits (logos, colors, fonts) via the new model + routes
- Version history retained per (tenantId, subBrand) — older versions kept for revert per DD-5.6
- Cross-vertical helper: `frontend/src/utils/travelSubBrand.js` (commit `9310196`) is the centralised SUB_BRAND_BG color map ready to be swapped to BrandKit-driven once consumer code lands

**Still pending:**
- DD-5.1 (custom font support — Google Fonts only v1; revisit if Yasin's Q22 brand pack specifies paid font)
- DD-5.3 (default brand kits at seed time — ship 4 starter kits via seed-travel.js)
- DD-5.4 (logo placement on operator UI — sidebar header)
- DD-5.5 (dark-mode handling — separate logoDarkUrl per sub-brand + auto-derive fallback)
- DD-5.6 (version-history purge cron — keep last 10 versions; older hard-purged)
- Brand-asset file upload (multer-based, future slice)
- WCAG contrast checker (DD-5.5e: warn on save when colors fail AA)
- Live preview UI consuming the BrandKit model
- Q22 brand pack from Yasin (CREDS_TRACKER Cat 2 row — unblocks 4 PRDs simultaneously)

**Path to next implementation slice:** Frontend BrandKit editor page (per-sub-brand color picker + logo upload + live preview). Depends on brand-asset file-upload (multer) backend support landing first. ~3-5 days for the editor + upload pipeline combined.

---

- **Current state** — `Tenant.subBrandConfigJson` slot exists and is consumed by `subBrandConfig.js` for 1 surface (WABA messaging — wabaId/phoneNumberId/legalEntityCode/gstin/driveRootFolderId). 9+ consumer surfaces NOT yet consuming any sub-brand-scoped branding (sidebar, operator UI, PDF templates, email templates, SMS/WhatsApp display name, customer portal, embed widget, landing pages, microsites). All currently render with tenant-wide branding only.
- **This PRD** — WRITTEN 2026-05-23 (tick #23).
- **Path to implementation** — 8-15 engineering days (depends on DD-5.2 schema choice; full `BrandKit` model with version history is the larger end). Phased rollout: phase 1 (schema + admin UI + sidebar/operator) ~4 days, phase 2 (PDF + email + portal) ~4 days, phase 3 (embed + microsites + landing pages + version history) ~4 days.
- **Blockers** — Q-BR-1 (Yasin's brand assets per sub-brand); DD-5.1 / DD-5.2 / DD-5.3 / DD-5.4 / DD-5.5 / DD-5.6 design calls.
- **Sibling PRDs** — `PRD_TRAVEL_B2B_AGENT_PORTAL` (B2B portal consumes brand kit), `PRD_TRAVEL_BILLING` (invoice/voucher PDFs consume brand kit), `PRD_TRAVEL_QUOTE_BUILDER` (quote PDF + email consume brand kit). All three PRDs assume per-sub-brand brand kits exist — this PRD is upstream.

Refs #911

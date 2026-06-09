# PRD — Travel Marketing Flyer Studio

**Status:** DRAFT • **Owner:** Travel vertical squad • **Filed:** 2026-05-23 (tick #23)
**Refs:** GH #908 (P2 Travel Gap — Marketing flyer studio) • Travel Stall CRM Roadmap Tier P2 item 13
**Siblings:** [PRD_AI_SURFACES.md](PRD_AI_SURFACES.md) (AI copy + image generation task classes), [WHATSAPP_INTEGRATION_PRD.md](WHATSAPP_INTEGRATION_PRD.md) (share-to-WhatsApp distribution channel), [PRD_TRAVEL_B2B_AGENT_PORTAL.md](PRD_TRAVEL_B2B_AGENT_PORTAL.md) (sub-agents consume flyers downstream), [PRD_TRAVEL_QUOTE_BUILDER.md](PRD_TRAVEL_QUOTE_BUILDER.md) (per-trip flyer derived from quote)

---

## §1 Background + source attribution

### Current state (zero flyer authoring surface)
Travel agencies in 2026 push marketing content daily — new package launches, seasonal offers, group discounts, customer testimonials, last-minute deals. The CRM today has **no in-app authoring surface** for visual marketing collateral. Operators export bare PDFs (via `backend/services/pdfRenderer.js`) for quotes and invoices; for actual *marketing* flyers they bail out to Canva, Adobe Express, or external design contractors, then re-upload finished JPG/PDF files as `Attachment` rows. The round-trip is the friction: a Bali-deal flyer that should ship inside the CRM in 90 seconds takes 30-90 minutes across two tools, two browser tabs, and a re-upload.

The visual-builder *pattern* is precedented in this codebase. `LandingPageBuilder` (`frontend/src/pages/LandingPageBuilder.jsx` — visual block editor over the `LandingPage` Prisma model with `templateType` / `content` blocks JSON) ships a working drag-drop block editor for landing pages today. The Marketing Flyer Studio mirrors that pattern at a different output surface (flyer-shaped PDFs + share-ready images, not deployable web pages).

### Why a PRD for what looks like "another visual builder"
GH #908's four acceptance bullets read like a routine canvas-editor + library + export feature. Underneath are 5 load-bearing design calls (DD-5.1 editor library build-vs-embed, DD-5.2 asset storage provider, DD-5.3 AI image-gen provider, DD-5.4 template marketplace moderation, DD-5.5 brand-lock default) and 3 cred dependencies (Q-MF-1 asset storage, Q-MF-2 AI image-gen API key — overlapping with PRD_AI_SURFACES Q-AI-3, Q-MF-3 WhatsApp Business creds — overlapping with WHATSAPP_INTEGRATION Q9). Picking the editor library wrong (e.g. building in-house when Polotno would have shipped in 2 weeks) is a 4-6 week sunk cost. Pinning these in §5 makes the impl team's first sprint a decision-execution sprint, not a discovery sprint.

### Source attribution
- GH #908 issue body (verbatim ACs in §6 below).
- Travel Stall CRM — Implementation & Modification Roadmap (Google Doc) — Tier P2, item 13.
- `frontend/src/pages/LandingPageBuilder.jsx` — canonical visual-builder pattern to mirror.
- `backend/services/pdfRenderer.js` — canonical PDF render pipeline to extend.
- Tick #20 commit `621aab7` — `Tenant.subBrandConfigJson` consumer wiring provides the per-sub-brand brand-kit substrate.

### §1.2 Existing infrastructure (do NOT rebuild)

| Surface | Path | What it provides | How Flyer Studio consumes |
|---|---|---|---|
| Visual block builder | `frontend/src/pages/LandingPageBuilder.jsx` | Drag-drop block editor, block-type registry, preview pane, save-to-JSON model | MIRROR — extract the block-builder substrate into a shared `<VisualBuilder/>` component; flyer-specific block library plugs in |
| Template-storage model | `EmailTemplate` (`prisma/schema.prisma:1255`), `LandingPage` (`prisma/schema.prisma:1661`) | Precedent for per-tenant template rows with `content` blob, category, owner, timestamps | NEW model `MarketingFlyer` mirrors the shape — `tenantId`, `subBrandKey`, `templateBlocks Json`, `assetRefs Json`, `outputUrls Json` |
| PDF render service | `backend/services/pdfRenderer.js` (pdfkit-based, currently renders prescription / consent / branded invoice) | A4/letter PDF generation with embedded images, fonts, colors | EXTEND — add `renderFlyer(flyerId, format)` that consumes the block JSON and emits print-quality PDF |
| Image rasterization | (none) | — | NEW — add Puppeteer-based HTML-to-image renderer for PNG/JPG variants (WhatsApp-share-ready compressed + multi-aspect square / portrait / landscape) |
| AI copy + image | `backend/lib/llmRouter.js` | Task-classed LLM router (existing classes: `lead-junk-classify`, `deal-insight`, etc.) | EXTEND — add `marketing-flyer-copy` task class for headline/CTA/body drafts; add `marketing-flyer-image` task class for AI image gen (cred-blocked Q-MF-2) |
| Per-sub-brand branding | `Tenant.subBrandConfigJson` (621aab7) | Per-sub-brand logo URL, primary/secondary colors, font stack, tagline | CONSUME — brand-kit-aware block defaults; lock-to-brand mode reads from here |
| Attachment storage | `Attachment` model + `Multer` (`backend/middleware/upload.js`) | Per-tenant file uploads to `uploads/<tenantId>/<resource>/` | EXTEND for asset library; cred chase Q-MF-1 decides S3/Cloudinary migration path |
| WhatsApp send | `backend/services/whatsappProvider.js` + WhatsApp Cloud API | Per-tenant credentialed WhatsApp text + media send | CONSUME — flyer-PNG WhatsApp share goes through existing media-send endpoint (cred-blocked Q-MF-3 / WHATSAPP_INTEGRATION Q9) |
| Sequence step asset | `SequenceStep` (`prisma/schema.prisma`) | Sequence-engine step attaches assets per step | EXTEND `SequenceStep.attachmentRefs` to accept `{ kind: 'FLYER', flyerId }` — fulfills AC bullet "attach a flyer as the asset of a Sequence step" |
| Per-sub-brand scope | `subBrandAccess[]` on `User` (621aab7) | RBAC scoping per operator | CONSUME — flyer library filter respects sub-brand access |

---

## §2 Use cases

### 2.1 TMC marketer launches "Summer Europe school trips" flyer
Asha (TMC marketer) opens Flyer Studio, picks "TMC blank A4 portrait" template. The template auto-loads with the school-trips sub-brand kit (TMC navy + warm gold from `Tenant.subBrandConfigJson.tmc`). She adds a header block ("Summer Europe — Class IX-X — 12 nights"), a destination grid (4 photos: Paris / Rome / Barcelona / Amsterdam), a tier-pricing block (Bronze ₹1.2L / Silver ₹1.5L / Gold ₹1.8L per student), a CTA block ("WhatsApp +91 98xxxx — book by May 31"). Exports PDF for principal-distribution mail-out + PNG for WhatsApp broadcast. End-to-end 12 minutes.

### 2.2 RFU marketer creates Umrah package flyer
Hassan (RFU marketer) clones last month's Ramadan-Umrah flyer template, swaps the departure dates (May 18 / June 2 / June 22), updates the photo (Makkah skyline at maghrib), updates the price (₹85k → ₹78k seasonal markdown), exports. The brand kit (RFU green + cream from `subBrandConfigJson.rfu`) is locked — Hassan can't accidentally pick wedding-pink. PDF + WhatsApp-PNG ready in 4 minutes.

### 2.3 Travel Stall marketer creates weekend offer
Priya (Travel Stall marketer) creates a "Goa weekend ₹14,999/pax" flyer with a destination-grid block (6 family-resort photos), a "limited time" badge block, a WhatsApp CTA. The marketplace template library has 3 weekend-getaway templates pre-curated; she picks the most-converting one (usage count visible per template). Exports to PNG square (Instagram) + portrait (WhatsApp story) + PDF (print drop-flyers for the local school PTA meeting Saturday).

### 2.4 Visa Sure marketer creates "fast-track UK visa" flyer
Arjun (Visa Sure marketer) creates a stats-heavy flyer: hero ("UK Visa in 5 days"), three KPI tiles (97% approval rate / 5-day turnaround / 8,200 visas processed in FY25), a testimonial block ("Got my visa for my Cambridge interview in 4 days — Riya M."), CTA. Brand kit: Visa Sure professional-blue + white. Exports PNG for LinkedIn (1080×1080 square) + email-banner (1200×628).

### 2.5 Operator clones an existing flyer for next week's offer
Saturday morning, Hassan needs to repost last week's "Bali 7N family" flyer with new dates and a 5% markdown. He opens the flyer, hits "Duplicate", edits the dates + price in the existing blocks, exports. End-to-end 90 seconds. The new flyer is a `MarketingFlyer` row with `clonedFromId` pointer, so analytics can attribute revenue back to the original template.

### 2.6 Sales rep WhatsApp-shares a flyer directly from CRM to a lead
Karthik (Travel Stall rep) is on a call with a lead who's asking for "any family-package brochures." Karthik opens the Lead Detail page, hits "Share marketing material", picks the "Bali 7N family" flyer from the library, picks the lead's WhatsApp number from the contact card → flyer-PNG sent via `whatsappProvider.sendMedia()` → delivery confirmed in 4 seconds. The share is logged on the lead's timeline (`Touchpoint` row, kind `MARKETING_FLYER_SHARE`, with `flyerId` reference) so analytics tracks per-flyer reach.

### 2.7 AI assists with copy generation
Asha is stuck on the headline for the new "Summer Greece" flyer. She hits "AI suggest copy" → `llmRouter.route('marketing-flyer-copy', { destination: 'Greece', tripType: 'school-trip', durationNights: 10, ageGroup: '14-16' })` returns three headline variants: "Greece Awaits: 10 Nights in the Cradle of Civilization", "Class IX-X Greece Study Tour — Athens, Delphi, Santorini", "Greek History Comes Alive — 10 Nights for ₹1.6L Including Flights". Asha picks variant 2, edits one word, ships.

### 2.8 Marketer attaches flyer as Sequence-step asset
The TMC marketing manager schedules a "school principal drip" Sequence: Day 1 intro email → Day 4 testimonial WhatsApp → Day 7 *flyer* WhatsApp → Day 10 closing call. The Day-7 sequence step has `attachmentRefs: [{ kind: 'FLYER', flyerId: 42 }]` configured via the Flyer Studio's "use in Sequence" action. When the cron-driven `sequenceEngine` fires Day-7 for each enrolled principal, it renders the flyer-PNG and sends via WhatsApp.

---

## §3 Functional requirements

### FR-3.1 Flyer template editor

- **FR-3.1.1** Drag-drop visual block builder — mirror `LandingPageBuilder.jsx` substrate. Block-add via palette; block-reorder via drag handles; block-remove via per-block trash icon.
- **FR-3.1.2** Block-type registry: header (h1/h2 + subhead), image (single + multi-photo grid), text (rich text + bullet), button (CTA with link/phone/email/WhatsApp action), pricing-tile (single-tier + tier-comparison 2/3/4-up), testimonial (quote + author + optional photo), destination-grid (3-up / 4-up / 6-up photo grid with captions), footer (logo + contact + social handles), kpi-tile (number + label, 2/3/4-up), badge ("limited time", "popular", "new" stamps), divider (horizontal rule + spacer).
- **FR-3.1.3** Per-block style: font family / font size / weight / color / text-align / padding / margin / background-color / border-radius. All style props respect brand-kit defaults unless explicitly overridden (FR-3.3.3).
- **FR-3.1.4** Snap-to-grid (8px grid by default) + spacing visualizer (margin/padding outlines on hover). Aligns to design system; prevents pixel-imprecise blocks.
- **FR-3.1.5** Undo/redo stack (≥20 steps) within an active editor session. Server-side autosave every 30 seconds; manual save on Ctrl+S.
- **FR-3.1.6** Mobile-responsive preview toggle: A4 print / WhatsApp portrait (1080×1920) / Instagram square (1080×1080) / Email banner (1200×628). Same `templateBlocks` JSON; render layer adapts.
- **FR-3.1.7** Concurrent-edit lock: opening a flyer for edit acquires a `flyer.lock` row (60-minute TTL, refreshed on save). Second editor sees read-only mode + "Asha is editing — last save 2 minutes ago".

### FR-3.2 Asset library

- **FR-3.2.1** Per-tenant image library — `Asset` model rows with `tenantId`, `subBrandKey`, `kind ∈ { LOGO, PHOTO, ICON, ILLUSTRATION }`, `url`, `tags`, `uploadedBy`, `usageCount`. Tags free-form (e.g. "beach", "family", "Bali", "summer-2026").
- **FR-3.2.2** Asset upload: Multer pipeline (existing) accepts JPG/PNG/SVG up to 10MB each. Cred-blocked Q-MF-1 decides whether storage backend is local-disk (today) / S3 / Cloudinary.
- **FR-3.2.3** Asset search + filter: full-text on tags + filename; kind filter; sub-brand filter; uploader filter; date-range filter.
- **FR-3.2.4** AI image generation — STUB mode pending Q-MF-2 cred chase. UI exposes "Generate AI image" button; backend `llmRouter.route('marketing-flyer-image', { prompt })` returns a placeholder + logs a request for ops to fulfill manually (Phase 1). On Q-MF-2 resolution (DALL-E or Stable Diffusion key delivered), task class swaps from stub to real API call.
- **FR-3.2.5** Per-asset usage count + last-used timestamp. Frequently-used assets surface at the top of the library; stale assets (>180 days unused) flagged for archival.
- **FR-3.2.6** Bulk import: ZIP upload extracts JPGs/PNGs into the library, auto-tagged with the filename stem.

### FR-3.3 Brand consistency

- **FR-3.3.1** Per-sub-brand brand kit pulled from `Tenant.subBrandConfigJson.<subBrandKey>` (TMC / RFU / TravelStall / VisaSure). Fields: `logoUrl`, `primaryColor`, `secondaryColor`, `accentColor`, `fontFamilyHeading`, `fontFamilyBody`, `tagline`.
- **FR-3.3.2** Brand-kit-aware block defaults: when a marketer adds a header block in a TMC-flyer, the header font defaults to TMC's `fontFamilyHeading`, color defaults to `primaryColor`, etc.
- **FR-3.3.3** Lock-to-brand mode (per-flyer setting, default ON per DD-5.5 if accepted): operator can't override brand-defined colors or fonts (style picker grays out the brand-controlled props). Operator with `role=MANAGER` or `role=ADMIN` can toggle the lock off per-flyer.
- **FR-3.3.4** Brand-kit preview: per-flyer "Apply latest brand kit" button. If the sub-brand's brand kit was updated after the flyer was created, this button re-applies and shows a diff ("3 colors changed, 1 font changed — Apply / Cancel").

### FR-3.4 Output formats

- **FR-3.4.1** PDF export: print-quality A4 (210×297mm) or US letter (8.5×11"). Embedded fonts, vectorized text, CMYK-friendly colors. Render via extended `pdfRenderer.renderFlyer(flyerId)`.
- **FR-3.4.2** PNG export: multi-aspect — square (1080×1080), portrait (1080×1920 — WhatsApp story / Instagram reel cover), landscape (1920×1080 — Facebook cover / YouTube card), email-banner (1200×628). Render via Puppeteer HTML-to-image pipeline (new).
- **FR-3.4.3** WhatsApp-share-ready: PNG compressed to ≤5MB (WhatsApp Cloud API media limit) with optimal quality/size tradeoff. Defaults to portrait aspect.
- **FR-3.4.4** Watermark for draft state: flyers in `status=DRAFT` render with a diagonal "DRAFT" watermark; `status=PUBLISHED` flyers render clean.
- **FR-3.4.5** Output URLs cached: per format/aspect combo, the rendered URL is cached at `MarketingFlyer.outputUrls Json` keyed by `{ format, aspect }`. Re-render only triggers if `templateBlocks` or referenced assets changed (hash-compare).

### FR-3.5 Distribution flow

- **FR-3.5.1** Direct WhatsApp share: from Flyer Detail page or Lead Detail page, pick contacts or contact-list → flyer-PNG sent via `whatsappProvider.sendMedia()`. Per-recipient `Touchpoint` row logged with `flyerId`. Cred-blocked Q-MF-3 / WHATSAPP_INTEGRATION Q9.
- **FR-3.5.2** Email attach: single email (to one lead/contact) or bulk (to a Marketing segment). Flyer attached as PDF + optional inline-PNG preview. Email goes through existing `email.js` send pipeline.
- **FR-3.5.3** Public share URL: per-flyer signed URL (e.g. `https://crm.globusdemos.com/f/<slug>`) renders the flyer HTML in browser. Useful for paste-into-social-post flows. URL is per-tenant-scoped + revocable.
- **FR-3.5.4** Embed code: per-flyer iframe-embed snippet for partner-site embedding (sub-agent sites, RFU mosque-network sites). Snippet generates a lightweight HTML render via the same Puppeteer pipeline.

### FR-3.6 AI assistance (extend `llmRouter`)

- **FR-3.6.1** AI-drafted copy task class — `llmRouter.route('marketing-flyer-copy', { destination, tripType, durationNights, audience, priceTier, season })` returns three headline + CTA + body-text variants. Provider gating per existing llmRouter cred-chain.
- **FR-3.6.2** AI-suggested layouts — given a flyer-intent text ("school-trip Greece 10 nights ₹1.5L Class IX-X"), suggest 2-3 block arrangements (header-position, image-grid placement, pricing-tile style). Phase 1 stub returns rule-based layouts; Phase 2 ML-driven.
- **FR-3.6.3** AI image generation task class — `llmRouter.route('marketing-flyer-image', { prompt, aspectRatio, style })`. STUB-mode (Q-MF-2 cred-blocked) returns placeholder + ops-fulfillment-queue entry; real-mode (post-cred) returns DALL-E / Stable Diffusion / chosen-provider URL.
- **FR-3.6.4** Performance hint engine — after a flyer accumulates ≥100 impressions or ≥10 conversions, surface optimization suggestions on the editor: "Flyers with CTA color #2 outperform yours by 18% — switch?", "Headlines starting with a number convert 23% better — try numerical opening?". Phase 2; requires impression/conversion tracking (FR-3.5.x analytics).

### FR-3.7 Templates marketplace

- **FR-3.7.1** Curated templates per sub-brand: TMC schools (8-12 templates) / RFU Umrah (6-10 templates) / Travel Stall family (10-15 templates) / Visa Sure (5-8 templates). Initial seed set hand-designed by the operator's design team.
- **FR-3.7.2** Per-template metadata: title, sub-brand, category (offer / new-package / seasonal / testimonial / educational), preview thumbnail, usage count, conversion rate (Phase 2).
- **FR-3.7.3** Operator-submitted templates: marketers can mark their own flyer as "Submit as template" → admin moderation queue → on approval, becomes a tenant-wide template. Moderation flow per DD-5.4.
- **FR-3.7.4** Template marketplace search + filter: by sub-brand, category, usage count, conversion rate (Phase 2). Sortable + filterable.

---

## §4 Non-functional requirements

- **NFR-4.1 Editor performance.** Block-drag latency <50ms; preview re-render <200ms after edit; autosave <500ms.
- **NFR-4.2 Render performance.** PDF render <3s per flyer; PNG render <2s per format/aspect; bulk render of 4 aspects in parallel <4s total.
- **NFR-4.3 Mobile-responsive editor.** Operators on tablets (iPad Pro / Android tablets) must have a usable editor — block-add via tap, drag via touch, preview pane collapsible. Mobile phone editing is out of scope (Phase 2).
- **NFR-4.4 Asset library scale.** Per-tenant library supports 10K assets without UI degradation. Server-side pagination + lazy thumbnail loading.
- **NFR-4.5 Concurrent editing safety.** Lock-based; no last-write-wins. Lock expiration auto-recovery after 60min idle.
- **NFR-4.6 Brand-kit hot-reload.** Brand-kit updates propagate to all DRAFT flyers in <5 min (cron-driven re-cache); published flyers unaffected unless operator re-applies.
- **NFR-4.7 Multi-tenancy.** All assets, flyers, templates, brand kits scoped to `tenantId` + `subBrandKey`. No cross-tenant leakage.
- **NFR-4.8 RBAC.** Asset upload + flyer create requires `role ∈ { ADMIN, MANAGER, USER }` AND `subBrandAccess` to include the flyer's `subBrandKey`. Template marketplace submission requires `role ∈ { ADMIN, MANAGER }`. Brand-kit edit requires `role=ADMIN`.

---

## §5 Hand-over reqs / cred chase / design decisions

### Design decisions (require product call)
- **DD-5.1 Editor library — build vs embed.** Build in-house atop the LandingPageBuilder substrate (estimated 4-6 weeks) versus embed a third-party canvas SDK (Polotno — best-fit, $99-499/mo; GrapesJS — open-source, web-page-focused, needs flyer-specific adapter; Tldraw — open-source, freeform-canvas, light on template-system). Polotno is the strongest fit (template-driven, PDF/PNG export native, brand-kit support). Recommendation: embed Polotno for Phase 1, evaluate in-house for Phase 3. Hand-over decision.
- **DD-5.2 Asset storage backend.** Local disk (today's `Multer` default; cheap, no extra cred) vs S3 (de-facto standard; cred-blocked Q-MF-1) vs Cloudinary (transformations + CDN built in; cred-blocked Q-MF-1). Cloudinary's per-image transforms (resize, watermark, format-convert) replace 30% of FR-3.4.x rasterization work — strong fit but $89-549/mo. Hand-over decision.
- **DD-5.3 AI image generation provider.** DALL-E 3 (OpenAI; high quality, $0.040/image at 1024×1024) vs Stable Diffusion (self-host or Replicate; cheaper, ~$0.003/image, lower quality at default settings) vs Midjourney API (highest quality, $30-60/mo per seat, API in beta). DALL-E 3 is the safe default for Phase 1; Midjourney for premium tiers in Phase 2. Hand-over decision.
- **DD-5.4 Template marketplace moderation.** Open submission (any marketer submits, all approved instantly; risk: off-brand contamination) vs curator-only (admin team designs all templates; risk: 4-sub-brand × 20-templates = 80-template authoring backlog) vs admin-moderated queue (marketer submits → admin reviews → approved templates publish; balanced). Recommendation: admin-moderated queue. Hand-over decision.
- **DD-5.5 Brand-lock default.** Enforced by default (operators cannot accidentally pick wrong colors; strict but safe) vs operator-opt-in per flyer (more flexibility; risks off-brand flyers from non-design-trained marketers). Recommendation: enforced by default for new flyers; toggleable per-flyer by `role=MANAGER`+. Hand-over decision.

### Cred chase
- **Q-MF-1** Asset storage credentials — S3 access key + secret + bucket OR Cloudinary cloud name + API key + API secret. Overlaps with general CRM asset-storage modernization. Blocks: FR-3.2.2 (asset upload at scale beyond local disk).
- **Q-MF-2** AI image-gen API key — OpenAI API key (DALL-E 3) OR Replicate API key (Stable Diffusion) OR Midjourney enterprise key. OVERLAP: PRD_AI_SURFACES Q-AI-3. Blocks: FR-3.2.4 + FR-3.6.3 (live AI image generation; stub mode ships without).
- **Q-MF-3** WhatsApp Business credentials for share-from-CRM flow. OVERLAP: WHATSAPP_INTEGRATION_PRD Q9, PRD_TRAVEL_B2B_AGENT_PORTAL Q-B2B-3, multiple tick-#18 PRDs. Blocks: FR-3.5.1 (direct WhatsApp share).

### Vendor + ecosystem docs to procure
- Polotno API reference (https://polotno.com/docs/) — if DD-5.1 lands on Polotno.
- GrapesJS plugin development guide — fallback if Polotno declined.
- DALL-E 3 API docs + content policy — if DD-5.3 lands on DALL-E.
- Cloudinary asset-transformation reference — if DD-5.2 lands on Cloudinary.
- WhatsApp Business Cloud API media-send spec — already in scope via WHATSAPP_INTEGRATION_PRD.

---

## §6 Acceptance criteria (verbatim from GH #908 + expanded)

- **AC-6.1** Canvas editor with brand-locked templates: operator selects a TMC template → blocks pre-populate with TMC brand kit (primary color #122647, gold accent #C89A4E, TMC logo top-left). Operator cannot accidentally pick a non-brand color while brand-lock is ON.
- **AC-6.2** Operator creates new flyer from blank, adds 5 blocks (header + image-grid + pricing-tile + testimonial + CTA), saves. Flyer persisted with `templateBlocks` JSON in `MarketingFlyer` row.
- **AC-6.3** Export PNG: flyer renders to 1080×1920 PNG ≤5MB in <2s. File downloadable + auto-uploaded to `outputUrls.png_portrait`.
- **AC-6.4** Export PDF: flyer renders to A4 print-quality PDF in <3s. File downloadable + auto-uploaded to `outputUrls.pdf_a4`.
- **AC-6.5** Attach flyer as Sequence-step asset: marketing manager edits a Sequence step → asset picker shows flyer library → selecting a flyer sets `SequenceStep.attachmentRefs: [{ kind: 'FLYER', flyerId }]`. Cron-driven sequence-engine fires correctly with flyer-PNG attached.
- **AC-6.6** Flyer library per sub-brand: marketer browsing the library sees ONLY flyers whose `subBrandKey ∈ user.subBrandAccess`. Cross-sub-brand leakage blocked at API + UI levels.
- **AC-6.7** Clone existing flyer: operator picks a flyer, hits Duplicate → new flyer row with `clonedFromId` pointer + same `templateBlocks` (deep copy) opens in edit mode. Original untouched.
- **AC-6.8** AI copy suggestion: marketer hits "AI suggest headlines" → returns three variants in <5s. Stub-mode acceptable until Q-MF-2 resolves.
- **AC-6.9** WhatsApp share: rep picks flyer + lead from Lead Detail page, hits Share → flyer-PNG delivered via `whatsappProvider.sendMedia()` in <8s; `Touchpoint` row logged with `flyerId`. Cred-blocked until Q-MF-3 resolves.
- **AC-6.10** Brand-kit hot-reload: admin updates `subBrandConfigJson.tmc.primaryColor` → all TMC DRAFT flyers offer "Apply latest brand kit" within 5 minutes. Published flyers unaffected.

---

## §7 Out of scope (Phase 2 / 3 candidates)

- **Print-on-demand fulfillment.** Phase 3. Integrate with a print vendor (Printful / Vistaprint) for physical-flyer drop-printing direct from the CRM.
- **Animated / video flyers.** Phase 2. MP4/GIF output, motion-block library, transition timeline.
- **A/B testing of flyer variants.** Phase 2. Belongs in the separate `AbTest` model + sequencer. Flyer Studio outputs variants; A/B engine assigns + measures.
- **Multi-language flyers.** Phase 2. Localization is a separate cross-cutting concern (i18n strings, RTL layout for Arabic/Urdu RFU content).
- **Real-time collaborative editing.** Phase 2. Google-Docs-style multi-cursor co-editing. Phase 1 ships lock-based single-editor.
- **Programmatic flyer generation via API.** Phase 2. Public API endpoint for partner sites to POST flyer-intent JSON and get back rendered URLs.
- **Flyer-as-microsite.** Phase 3 — convert a flyer into a one-page landing site with form-capture. Convergence with `LandingPage` (today's tool) is the natural path.

---

## §8 Dependencies (build order)

1. `VisualBuilder` substrate extracted from `LandingPageBuilder.jsx` into a shared component (refactor, no behavior change). PRECONDITION.
2. `MarketingFlyer` + `Asset` Prisma models + migration. PRECONDITION.
3. `pdfRenderer.renderFlyer()` extension. ENABLES AC-6.4.
4. Puppeteer-based HTML-to-image pipeline (new service `imageRenderer.js`). ENABLES AC-6.3.
5. Brand-kit consumer on block defaults (reads `subBrandConfigJson`). ENABLES AC-6.1 + AC-6.10.
6. `llmRouter` task class `marketing-flyer-copy`. ENABLES AC-6.8.
7. `SequenceStep.attachmentRefs` schema extension. ENABLES AC-6.5.
8. Asset library UI + Multer upload pipeline. ENABLES FR-3.2.
9. WhatsApp share integration via `whatsappProvider.sendMedia()`. ENABLES AC-6.9 (cred-blocked Q-MF-3).
10. Template marketplace + moderation flow (Phase 1.5).
11. AI image generation task class (cred-blocked Q-MF-2, ship stub-mode + swap-point inventory).

External cred-blocked dependencies (do NOT block Phase 1 launch — ship stub-modes):
- Q-MF-1 asset storage (S3 / Cloudinary) — local-disk acceptable until tenant > 1K assets.
- Q-MF-2 AI image-gen API — stub returns placeholder image with ops-fulfillment-queue entry.
- Q-MF-3 WhatsApp share — manual-download + paste-into-WhatsApp acceptable until cred lands.

---

## §9 Open questions

- **OQ-9.1** Should AI-generated images watermark as "AI" by default? Some marketers want clean unwatermarked output; ethics/regulatory may push toward mandatory AI-disclosure on marketing collateral (esp. India's emerging AI-disclosure rules). Recommendation: opt-in unwatermarked for `role=MANAGER`+; watermarked-default for `role=USER`.
- **OQ-9.2** Per-flyer analytics — who viewed, who shared, who converted. Privacy implications: tracking per-lead engagement at flyer granularity. DPA review needed for GDPR-region tenants. Currently tracked: send-touchpoint per recipient. Recommended: opt-in per-tenant for view-tracking.
- **OQ-9.3** Operator workflow: per-package flyer (one flyer per `Product` row) versus reusable templates (one template → many flyers via clone). Both should work; the question is which is the *default UX* for "marketer needs a flyer". Recommendation: surface both in the editor, default to "from template" for marketers, "from blank" for designers.
- **OQ-9.4** Customer-side rendering: do recipients see live flyers (URL renders current state from blocks JSON) or pre-rendered images (fixed at send-time)? Tradeoff: live = always-fresh content but requires public-renderer endpoint + introduces edit-after-send risk (sender edits the flyer after sharing, recipient sees a different version); pre-rendered = immutable snapshot, can drift from current "official" version. Recommendation: pre-rendered for WhatsApp/email shares (immutable snapshot at send time); live URL for public-share link (always-current).
- **OQ-9.5** Audit + accessibility — minimum WCAG AA contrast checks for text-on-image blocks. Phase 1 surfaces a warning ("text contrast below AA — illegible to readers with low vision"); Phase 2 enforces.
- **OQ-9.6** Sub-agent flyer library access — when PRD_TRAVEL_B2B_AGENT_PORTAL ships, do sub-agents get read-only access to the flyer library (for download + reshare), edit access (with their own markup), or no access (operator must explicitly share)? Recommendation: read-only-with-download for Phase 1; per-sub-agent-brand-kit + edit access in Phase 2.

---

## §10 Status snapshot

### 2026-06-09 refresh — FlyerTemplates + Studio SHELL live; canvas editor + render pipeline pending

**Current state:** The "ZERO flyer authoring surface" claim is OBSOLETE. Slices 1-5 are SHIPPED: the FlyerTemplates list page + Marketing Flyer Studio Phase 2 SHELL with palette/layout/assets local state + Save-as-Template flow + `?template=<id>` seeding. The studio header self-labels as "non-functional scaffold" until the canvas editor + render pipeline land. DD-5.1 (Polotno vs in-house) remains the gating product call before sprint-1 implementation can start.

**SHIPPED:**
- ✅ `backend/routes/travel_flyer_templates.js` — extensive CRUD + slices (POST/PUT/GET)
- ✅ `backend/lib/flyerExport.js` + tests
- ✅ `backend/lib/flyerTemplateValidator.js`
- ✅ `frontend/src/pages/travel/FlyerTemplates.jsx` list page + tests
- ✅ `frontend/src/pages/travel/MarketingFlyerStudio.jsx` — Phase 2 SHELL with palette/layout/assets local state + Save-as-Template flow + `?template=<id>` seeding
- ✅ `App.jsx` routes mounted (`/travel/flyer-templates`, MarketingFlyerStudio path)

**Pending (in-PRD work):**
- ⬜ Drag-drop canvas editor with full block-type registry (FR-3.1.1-3.1.7) — ~8-10d (or ~5d via Polotno per DD-5.1)
- ⬜ Asset library + Multer pipeline + tag search (FR-3.2) — ~3d
- ⬜ AI copy task class `marketing-flyer-copy` (FR-3.6.1) — ~1d
- ⬜ AI image task class `marketing-flyer-image` stub-mode (FR-3.6.3) — ~1d
- ⬜ PDF + multi-aspect PNG render via Puppeteer (FR-3.4) — ~3d
- ⬜ WhatsApp share flow (FR-3.5.1) — ~1d
- ⬜ `SequenceStep.attachmentRefs` flyer kind extension (FR-3.5/AC-6.5) — ~½d
- ⬜ Brand-lock + brand-kit hot-reload (FR-3.3) — ~1d
- ⬜ Public share URL + embed code (FR-3.5.3-5.3.4) — ~1d

**Blocked (design decisions / creds):**
- 🔵 DD-5.1 Polotno embed vs in-house — needs product call before sprint 1
- 🔵 DD-5.3 AI image provider
- 🔵 Q-MF-1 asset storage cred
- 🔵 Q-MF-2 AI image API key (overlaps Q-AI-3)
- 🔵 Q-MF-3 WhatsApp Business creds (overlaps Q9)

**Net remaining: ~18-22 engineering days** (Polotno fork shrinks canvas editor ~5d). All three Q-MF creds overlap sibling PRDs (Q-AI-3, Q9) — resolving them unlocks 4+ workstreams.

- **Status flag:** DRAFT — pending design-decision sign-off (DD-5.1 through DD-5.5) and cred-chase resolution (Q-MF-1, Q-MF-2, Q-MF-3).
- **Sibling PRDs:** [PRD_AI_SURFACES.md](PRD_AI_SURFACES.md) (donates the AI copy + AI image task-class infrastructure), [WHATSAPP_INTEGRATION_PRD.md](WHATSAPP_INTEGRATION_PRD.md) (donates the share-to-WhatsApp distribution channel), [PRD_TRAVEL_B2B_AGENT_PORTAL.md](PRD_TRAVEL_B2B_AGENT_PORTAL.md) (downstream consumer of flyer library — sub-agents reshare flyers), [PRD_TRAVEL_QUOTE_BUILDER.md](PRD_TRAVEL_QUOTE_BUILDER.md) (sibling visual builder for per-quote PDFs — Quote Builder pattern feeds Flyer Studio pattern).
- **Anti-busywork guardrail:** Do not start in-house canvas editor build until DD-5.1 is resolved (sunk cost: 4-6 weeks if Polotno would have worked). Do not chase Q-MF-2 / Q-MF-3 independently — they're already on the cred-chase backlog via sibling PRDs.

---

*Filed by autonomous overnight cron tick #23 (PRD-WRITER Agent 1). Refs #908.*

# PRD — Zylu Parity-Gap Consolidated Cluster

**Status:** WRITTEN 2026-05-23 (autonomous cron tick #30)
**Coordinates:** GH #771, #775, #788, #805, #809, #816, #834, #835
**Sibling PRDs:** PRD_WELLNESS_POS_HARDENING (#771/#775 overlap), PRD_TRAVEL_PER_SUBBRAND_BRANDING (#809 brand-kit), PRD_TRAVEL_MARKETING_FLYER (#809 visual-editor pattern)

---

## §1. Background + source attribution

Globussoft benchmarks the wellness CRM (Enhanced Wellness tenant) against **Zylu** — a competitive wellness/salon SaaS platform. During the May 2026 audit of staging (`crm.globusdemos.com`), 8 parity gaps were filed as `[Zylu-Gap]` GitHub issues across 5 themes: POS, Inventory, Memberships, Wallet, Attendance, and Mini Website. They are scattered but interdependent — e.g. Wallet (#788) requires polymorphic Invoice (#775) for wallet-top-up receipts; Memberships (#835) requires Wallet (#788) for perks crediting; Mini Website (#809) inherits the brand-kit consumer pattern from PRD_TRAVEL_PER_SUBBRAND_BRANDING.

This coordinating PRD organises the 8 gaps by theme + explicitly identifies sibling-PRD overlap so design decisions don't fragment across 3-4 separate documents.

**Source attribution:** Zylu competitive audit (May 2026) + GH #771, #775, #788, #805, #809, #816, #834, #835.

### §1.1 Theme map

| Theme | Gap-issues | Existing spine | Net new |
|-------|-----------|----------------|---------|
| POS extensions | #771, #775 | Invoice, Register, Shift, Sale | Polymorphic sourceType, Booking/Walk-in tabs |
| Inventory back-office | #816, #834 | Product, ProductCategory, Vendor, InventoryReceipt, InventoryAdjustment | CSV import/export, working UIs |
| Memberships engine | #835 | MembershipPlan, Membership, MembershipRedemption | Engine wiring (sell/renew/auto-debit) |
| Wallet system | #788 | Wallet, WalletTransaction | Top-up flow with bonus rules + expiry |
| Attendance hardware | #805 | Attendance, Leave | Biometric API + geofence mobile |
| Mini Website | #809 | _none_ | Per-tenant mini-site editor + public URL |

### §1.2 Existing infrastructure (do NOT rebuild — verified `backend/prisma/schema.prisma` 2026-05-23)

| Surface | Status | Reference |
|---------|--------|-----------|
| Invoice model | EXISTS but non-polymorphic | `schema.prisma:805` — no `sourceType`, no line-items table, no payments-spine table |
| Wallet + WalletTransaction models | EXISTS | `schema.prisma:3431` + `3447` — ledger spine present |
| MembershipPlan + Membership + MembershipRedemption | EXISTS | `schema.prisma:3218` + `3240` + `3273` — shell present, engine unverified |
| Product / ProductCategory / Vendor | EXISTS | `schema.prisma:983` + `3307` + `3327` |
| InventoryReceipt / InventoryAdjustment | EXISTS | `schema.prisma:3346` + `3373` |
| Attendance model | EXISTS | `schema.prisma:3598` |
| POS surface | EXISTS (`PointOfSale.jsx` + Register + Shift + Sale) | Covered by PRD_WELLNESS_POS_HARDENING |
| Microsite / MiniSite model | DOES NOT EXIST | Net new for wellness (Travel TMC has `MicrositePreview.jsx`) |
| Tenant.subBrandConfigJson | EXISTS (consumed by 7 crons + 3 endpoints per `621aab7`) | Brand-kit spine available |

The pattern: **most spines exist; the gap is wiring, UI, and one missing model (Microsite).** This PRD is heavier on wiring + UI than on data-model design.

---

## §2. Use cases

**POS use cases**
- UC-2.1 Cashier opens New Sale → picks Booking tab (linked to existing Visit) vs Walk-in tab (no Visit) → completes sale → invoice tagged with sourceType.
- UC-2.2 Cashier voids/refunds a sale → polymorphic invoice ledger preserves trail per source type.

**Inventory use cases**
- UC-2.3 Owner imports product catalog from CSV/XLSX → column-mapping preview → commit transactional.
- UC-2.4 Owner exports current inventory state → CSV with same column shape as importer (round-trip safe).
- UC-2.5 Operator creates a new InventoryReceipt (goods-in) → stock counter increments + receipt PDF generated.
- UC-2.6 Operator records an InventoryAdjustment (damage / loss / count-correction) → audit trail preserved.

**Memberships use cases**
- UC-2.7 Owner creates a Membership Plan (e.g. "Gold ₹15k/year, 12 facials + ₹2k wallet credit + priority booking") → plan visible in storefront.
- UC-2.8 Customer purchases a Plan → Membership row created, wallet credited per plan rules, perks active.
- UC-2.9 Customer redeems a perk (free facial, priority slot) → MembershipRedemption logged, balance decremented.
- UC-2.10 Cron renews / expires memberships nightly → notification + invoice generated for auto-debit plans.

**Wallet use cases**
- UC-2.11 Owner credits customer wallet ₹5000 → +10% bonus per rule → ledger entry with 90-day expiry.
- UC-2.12 Customer wallet auto-applied at POS checkout (toggleable opt-in).
- UC-2.13 Expired wallet entries removed from spendable balance; audit log preserved.
- UC-2.14 Wallet refund / reversal (e.g. service cancellation) → negative entry + reason code.

**Attendance use cases**
- UC-2.15 Staff arrives at clinic → biometric device sends event to webhook → Attendance row created.
- UC-2.16 Field-worker / mobile staff on-route → opens mobile app → geofence verifies within radius → check-in stamped with lat/lng + device fingerprint.
- UC-2.17 Failed check-in (out-of-radius, biometric mismatch) → audit log entry, no Attendance row.

**Mini Website use cases**
- UC-2.18 Owner navigates to Settings → Mini Website → edits logo, hero image, hero copy, service display order, contact info.
- UC-2.19 Customer visits `/clinic/:slug` (no auth) → sees clinic profile + service list + book-now CTA.

---

## §3. Functional requirements

### FR-3.1 POS extensions (#771 #775) — overlaps PRD_WELLNESS_POS_HARDENING
- FR-3.1.1 New Sale screen exposes **Booking tab** that lists today's checked-in/in-progress Visits → cashier picks one → sale auto-links to `visitId`.
- FR-3.1.2 New Sale screen exposes **Walk-in tab** that allows ad-hoc customer + service selection without prior Visit.
- FR-3.1.3 Invoice schema extends with `sourceType` enum: `{booking, walkin, treatmentPlan, membership, walletTopup, recurring}` (default `walkin` for migration).
- FR-3.1.4 Invoice schema adds child table `InvoiceLineItem` (item type / SKU / qty / unitPrice / discount / lineTotal) so polymorphic shapes share a common renderer.
- FR-3.1.5 Invoice schema adds child table `InvoicePayment` (method / amount / txnRef / timestamp) — separates "what was billed" from "how it was paid" (cash + UPI + wallet split on one bill).
- FR-3.1.6 Per-sourceType receipt PDF templates: booking-receipt shows Visit context; walk-in-receipt shows item list; membership-receipt shows plan benefits.
- FR-3.1.7 Migration: existing Invoice rows get `sourceType='legacy'` + single auto-derived InvoiceLineItem from `amount` field.

### FR-3.2 Inventory CSV (#816 #834) — extends existing inventory models
- FR-3.2.1 CSV importer at `/inventory/import` accepts CSV/XLSX → preview pane shows first 50 rows + per-column type/match indicator.
- FR-3.2.2 Column mapper UI: user drags CSV header → Product field (or marks "ignore"). Saved mappings persist per-tenant for re-use.
- FR-3.2.3 Import commits transactionally (all rows or none); failure surfaces per-row error CSV download.
- FR-3.2.4 CSV exporter at `/inventory/export` outputs **same column shape** as importer (round-trip identity).
- FR-3.2.5 Bulk update operations: select N rows on Inventory page → bulk-edit category / vendor / reorder-level / price.
- FR-3.2.6 Per #834: verify-and-wire the existing Categories / Vendors / Receipts / Adjustments pages (currently empty shells). Each page gets list + create + edit + delete + filter.
- FR-3.2.7 Auto-consumption rule: when a Service that lists `consumesProductId` is delivered (via Visit completion), decrement Product stock + log ServiceConsumption entry.
- FR-3.2.8 Exports cover: services, products, packages, customers, bookings (per #816 scope).

### FR-3.3 Memberships engine (#835)
- FR-3.3.1 MembershipPlan CRUD with fields: name, price, duration, perks JSON (discount %, wallet credit, priority booking, freebie count).
- FR-3.3.2 Sell flow: POS → "Sell Membership" → pick plan → customer → payment → Membership row created + auto-credit wallet per plan rules.
- FR-3.3.3 Renewal flow: nightly cron at 03:30 IST scans Memberships expiring in next 7 days → notification to customer + (for auto-debit plans) invoice generated.
- FR-3.3.4 Redeem flow: customer presents membership at POS → cashier picks perk → MembershipRedemption row created + balance decremented.
- FR-3.3.5 Expiry flow: memberships past `expiresAt` flagged inactive; wallet credits from that plan also expire if linked.
- FR-3.3.6 Membership-to-Visit linking: when Visit is logged for a Membership-holding customer, applicable perks (discount, freebie) auto-suggested on the Visit's invoice.
- FR-3.3.7 Staging verification: Memberships page must show ≥3 demo plans + at least 1 active membership for a seeded customer (closes the #835 "unverifiable on staging" bit).

### FR-3.4 Wallet system (#788)
- FR-3.4.1 Wallet auto-created per (tenantId, customerId) on first credit; opening balance 0.
- FR-3.4.2 Top-up flow at `/wallet/topup`: pick customer + amount + payment method → if amount triggers a bonus rule, bonus credited as separate WalletTransaction with own expiry.
- FR-3.4.3 Bonus rules engine (admin UI under Settings → Wallet Rules): array of `{minAmount, bonusPct, label}` — e.g. `[{minAmount: 5000, bonusPct: 10, label: "₹5k+ tier"}, {minAmount: 10000, bonusPct: 15, label: "₹10k+ tier"}]`.
- FR-3.4.4 Per-entry expiry: each WalletTransaction has its own `expiresAt`; default 90 days, configurable per bonus rule.
- FR-3.4.5 Spendable-balance calculation: sum of non-expired credits − sum of debits.
- FR-3.4.6 POS auto-apply: at checkout, if `customer.walletAutoApply === true`, default the wallet split to min(spendable, invoiceTotal).
- FR-3.4.7 Refund / reversal: cancelling a wallet-funded sale creates a positive WalletTransaction (credit-back) tagged with `reason: 'refund'` + reference to original debit.
- FR-3.4.8 Wallet ledger view: per-customer history of all WalletTransactions, with running balance + expiry warning chips (red ≤7 days).

### FR-3.5 Attendance hardware (#805)
- FR-3.5.1 Webhook endpoint `/api/wellness/attendance/biometric` accepts device events: `{deviceId, employeeRef, eventType, timestamp}` → resolves to User → creates Attendance row.
- FR-3.5.2 Mobile check-in endpoint `/api/wellness/attendance/geofence-checkin` accepts `{lat, lng, accuracy, deviceFingerprint}` → verifies user is within `Location.geofenceRadiusM` (default 100m) of their assigned location → creates Attendance row.
- FR-3.5.3 Location model extension: add `latitude`, `longitude`, `geofenceRadiusM` columns.
- FR-3.5.4 Failed check-ins logged to `AttendanceAuditLog` (new model) with reason code (`out_of_radius`, `mock_location_detected`, `biometric_mismatch`, `device_unknown`).
- FR-3.5.5 Biometric device pairing UI: per-location admin pairs deviceId + maps to staff list.
- FR-3.5.6 Per-attendance event: emit `attendance.checkin` event for downstream consumers (payroll, shift-management, SLA).
- FR-3.5.7 Anti-spoofing: reject mobile check-ins with `isFromMockProvider === true` (Android) or simulator on iOS (best-effort).

### FR-3.6 Mini Website editor (#809)
- FR-3.6.1 New Microsite model with fields: `id, tenantId, slug, isPublished, logoUrl, heroImageUrl, heroHeadline, heroSubcopy, contactPhone, contactEmail, contactAddress, serviceDisplayOrderJson, themeOverrideJson, updatedAt`.
- FR-3.6.2 Editor UI at `/settings/microsite` with block-by-block edit (logo block, hero block, services block with drag-to-reorder, contact block).
- FR-3.6.3 Image uploads for logo + hero → tenant-scoped S3/disk storage.
- FR-3.6.4 Public read endpoint `/clinic/:slug` (no auth) returns the published Microsite + active services list.
- FR-3.6.5 Theme consumes `Tenant.subBrandConfigJson` (existing per `621aab7`) for default colors/fonts; per-microsite override possible.
- FR-3.6.6 Publish workflow: edits stay in draft until owner clicks "Publish"; previous published version archived.
- FR-3.6.7 SEO: meta title + description + Open Graph image fields per microsite.
- FR-3.6.8 Cross-ref PRD_TRAVEL_PER_SUBBRAND_BRANDING (brand-kit consumer) + PRD_TRAVEL_MARKETING_FLYER (visual editor pattern + image-upload pipeline).

---

## §4. Non-functional requirements

- NFR-4.1 CSV import handles up to 10K rows in <30s on a single tenant (chunked transaction; row-level errors surfaced).
- NFR-4.2 Wallet ledger writes are transactional — top-up + bonus credit + audit log either all commit or all roll back.
- NFR-4.3 Biometric webhook latency <2s end-to-end (device → Attendance row).
- NFR-4.4 Mini-site public page TTFB <2s on 4G; LCP <2.5s; images served via CDN/Nginx-cached.
- NFR-4.5 Polymorphic Invoice migration runs online — existing rows backfilled in <5 min on production-sized data.
- NFR-4.6 Memberships nightly cron completes in <60s per tenant.
- NFR-4.7 Wallet spendable-balance read latency <50ms p99.
- NFR-4.8 Microsite editor saves auto-debounce at 2s + explicit Save button.

---

## §5. Hand-over reqs / cred chase / design decisions

### Design decisions (require user / Rishu call)
- **DD-5.1 POS Invoice polymorphism: schema fork vs sourceType enum?** Recommended: sourceType enum + shared child tables (InvoiceLineItem + InvoicePayment). Single fork would explode joins.
- **DD-5.2 CSV column-mapping UI: drag-drop or fixed columns?** Recommended: drag-drop with fuzzy-match auto-suggest + save mapping per tenant. Fixed columns brittle when CSV source varies.
- **DD-5.3 Memberships: per-tenant SKUs or central catalog?** Recommended: per-tenant. Each clinic prices differently; central catalog would force ops overhead.
- **DD-5.4 Wallet bonus rules: admin UI or hard-coded?** Recommended: admin UI. Bonus rules change quarterly; hard-coding forces a deploy per change.
- **DD-5.5 Wallet expiry: per-entry OR per-balance (FIFO)?** Recommended: per-entry. Per-balance FIFO is friendlier to customer but harder to render audit trail.
- **DD-5.6 Biometric device vendor?** Open. Common options: Mantra, Realtime, eSSL. Decision drives webhook contract + device-pairing UI.
- **DD-5.7 Mini-site editor: in-app block builder OR templates?** Recommended: block builder (4-5 blocks: logo/hero/services/contact/cta). Template choice = scope creep into a website builder.
- **DD-5.8 Per-clinic-location mini-site or per-tenant?** Open. If chain (e.g. 3 clinics), each location may want its own page vs one umbrella.

### Cred chase / vendor onboarding
- **Q-ZG-1** Biometric device vendor API credentials (after DD-5.6).
- **Q-ZG-2** Microsite public-URL hostname strategy: subdomain (`clinic.globusdemos.com/:slug`) OR path-based (`/clinic/:slug`)?
- **Q-ZG-3** S3/storage credentials for microsite logo + hero image hosting (or use existing tenant file storage).

### Vendor docs
- TBD per DD-5.6 (biometric device API docs).
- TBD per DD-5.7 (any image-upload + crop UI library — recommendation: reuse from PRD_TRAVEL_MARKETING_FLYER decision once made).

---

## §6. Acceptance criteria

- AC-6.1 Cashier completes a Booking-tab sale → invoice persists with `sourceType='booking'` + `visitId` set + InvoiceLineItem rows match cart.
- AC-6.2 Cashier completes a Walk-in sale → invoice persists with `sourceType='walkin'` + `visitId IS NULL` + InvoiceLineItem rows present.
- AC-6.3 CSV import of 1000 products: preview shows correct column mapping + commit transactional + row count exactly 1000 + export of resulting state matches input shape.
- AC-6.4 Owner creates Membership plan → customer purchases → Membership row active + wallet credited per plan rules + perks visible on customer profile.
- AC-6.5 Wallet top-up ₹5000 → +10% bonus rule fires → ledger shows 2 entries (₹5000 base + ₹500 bonus) + both with `expiresAt` set.
- AC-6.6 Biometric device tap → Attendance row appears within 2s + linked to correct User.
- AC-6.7 Mobile geofence check-in within radius succeeds; outside radius logs `AttendanceAuditLog` + returns 422.
- AC-6.8 Owner edits mini-site logo + hero + service order → clicks Publish → `/clinic/:slug` renders updated content within 5s.
- AC-6.9 Expired wallet entries (past `expiresAt`) excluded from spendable balance + audit log entry preserved.
- AC-6.10 Memberships nightly cron: expiring memberships in next 7 days get notification; auto-debit plans get invoice generated.
- AC-6.11 Inventory bulk-update of 50 rows commits atomically + audit log lists the diff.

---

## §7. Out of scope

- White-label cross-tenant branding (sibling PRD_TRAVEL_PER_SUBBRAND_BRANDING handles tenant-level brand kits).
- Multi-clinic mini-site cross-linking (e.g. "see our other locations" widget) — defer to v2 of #809.
- AI-suggested wallet top-up amounts (defer; rule-based only in v1).
- Insurance-claim integrations (out of Zylu's surface too).
- POS hardware integrations (receipt printers, barcode scanners) — separate hardware-integration PRD.
- Multi-currency wallet (single-currency per tenant; per existing `Tenant.defaultCurrency`).
- SCIM-driven attendance (use existing User table; SCIM-sync is sibling concern).
- Mini-site online ordering / payment (book-now CTA opens existing booking flow only).

---

## §8. Dependencies

- POS hardening models (existing — cross-ref PRD_WELLNESS_POS_HARDENING for the cashier-side UX work that #771 must not duplicate).
- Existing Wallet + WalletTransaction models (`schema.prisma:3431, 3447`).
- Existing MembershipPlan + Membership + MembershipRedemption models (`schema.prisma:3218, 3240, 3273`).
- Existing Product / ProductCategory / Vendor / InventoryReceipt / InventoryAdjustment models (`schema.prisma:983, 3307, 3327, 3346, 3373`).
- Existing Attendance model (`schema.prisma:3598`) — extends with geofence + biometric webhook routes.
- Existing Invoice model (`schema.prisma:805`) — migrates to polymorphic (adds sourceType + child tables).
- `Tenant.subBrandConfigJson` (existing per `621aab7`) — Microsite consumes for default theme.
- Sibling PRD_TRAVEL_PER_SUBBRAND_BRANDING (brand-kit consumer pattern).
- Sibling PRD_TRAVEL_MARKETING_FLYER (visual-editor + image-upload pipeline pattern).
- Sibling PRD_WELLNESS_POS_HARDENING (#771 / #775 overlap — design must land in coordination).

---

## §9. Open questions

- **OQ-9.1** Memberships vs Wallet — should they share a single ledger (membership credit IS a wallet entry tagged with `source='membership'`) or stay separate ledgers? Recommendation: shared ledger; tag wallet entries by source.
- **OQ-9.2** Mini-site: per-clinic-location or per-tenant? See DD-5.8.
- **OQ-9.3** Biometric: clinic-side device OR mobile-only OR both? Recommendation: both, with device as primary at owned locations + mobile fallback for field/multi-location staff.
- **OQ-9.4** CSV import: do we offer schema migration on category-not-found (auto-create) or hard-fail? Recommendation: prompt-during-preview (user confirms auto-create), so commit phase is unambiguous.
- **OQ-9.5** Polymorphic invoice: backward-compat for existing rows? Recommendation: backfill `sourceType='legacy'` + single auto-derived LineItem from `amount`; reports treat `legacy` as "best-effort, no breakdown".
- **OQ-9.6** Wallet refund — does it bypass the original entry's expiry (credit-back gets fresh 90d) or inherit (credit-back inherits original expiresAt)? Recommendation: fresh expiry; refund is a new transaction.
- **OQ-9.7** Memberships auto-debit: which payment-provider flow do we wire (Razorpay subscriptions, Stripe subscriptions, manual UPI mandate)?
- **OQ-9.8** Mini-site i18n — single language per tenant or multi-lang switcher? Recommendation: single (matches `Tenant.locale`); multi-lang is v2.

---

## §10. Status snapshot

- **Current state:** 8 Zylu parity gaps OPEN as of 2026-05-23.
- **This PRD:** WRITTEN 2026-05-23 (autonomous cron tick #30).
- **Coordinates 8 GH issues:** #771 (POS Booking/Walk-in tabs), #775 (Invoice polymorphism), #788 (Wallet top-up + bonus rules), #805 (Biometric + geofence), #809 (Mini Website), #816 (Catalog CSV), #834 (Inventory back-office), #835 (Memberships engine).
- **Sibling PRDs:**
  - `PRD_WELLNESS_POS_HARDENING.md` — #771 + #775 overlap (Booking/Walk-in tabs + polymorphic Invoice).
  - `PRD_TRAVEL_PER_SUBBRAND_BRANDING.md` — #809 brand-kit consumer pattern.
  - `PRD_TRAVEL_MARKETING_FLYER.md` — #809 visual-editor pattern + image-upload pipeline.
- **Estimated path to remediation:** 30-50 engineering days, broken into 5 themed work-streams:
  - WS-1 POS polymorphism + Booking/Walk-in tabs (~7-10 days; #771 #775)
  - WS-2 Wallet top-up + bonus engine + POS auto-apply (~5-7 days; #788)
  - WS-3 Memberships engine wiring + nightly cron (~6-9 days; #835)
  - WS-4 Inventory CSV + back-office UI wire-up (~5-8 days; #816 #834)
  - WS-5 Attendance hardware (biometric + geofence) (~4-6 days; #805)
  - WS-6 Mini Website editor + public URL (~6-9 days; #809)
- **Blockers:** DD-5.6 (biometric vendor), Q-ZG-1 (vendor API creds), DD-5.8 (mini-site granularity), OQ-9.7 (auto-debit provider) — all need Rishu's product call before WS-3 + WS-5 start.
- **Path A vs Path B sizing:** Most work is **wiring + UI** (Path A — pin existing models). The only **Path B** (new model) is Microsite (#809). Per `sizing-regression-coverage-dispatch` heuristic, the WS-6 budget should carry +50% headroom; others should stay close to point estimate.

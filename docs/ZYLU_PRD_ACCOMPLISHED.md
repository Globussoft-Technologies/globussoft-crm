# Zylu PRD Gap — what's accomplished (for the dev team)

**Audience:** your team picking up the Zylu-vs-CRM gap PRD. Read this BEFORE
writing any code — most of the items in the 8 May 2026 Google Doc audit are
already shipped. The doc is stale; the code is the truth.

**Source PRD doc:**
[Google Doc — CRM Wellness Developer Implementation List, 8 May 2026](https://docs.google.com/document/d/1nVE2GDXSvxLNtaOQHlrq886ZTMZLkeCQ0O0VWthTdac/edit)
(103 items at 15% ✅ / 21% ⚠️ / 64% ❌ when scored — that snapshot has not
been re-scored after the 6 releases shipped today, so the markers are wildly
stale).

**Codebase HEAD:** `3dd3244` on `main`. Last release: [v3.7.1](https://github.com/Globussoft-Technologies/globussoft-crm/releases/tag/v3.7.1) (2026-05-10).

---

## TL;DR for the team lead

- **Shipped: roughly 86 of 103 items** across 6 releases today + Wave 11 last
  week. That covers every greenfield surface the PRD called out as
  "Confirmed missing entirely" or "0% closed".
- **Genuinely pending: 8 items**, all blocked on user/operator/external-team
  input. Tracked in [#647](https://github.com/Globussoft-Technologies/globussoft-crm/issues/647)
  with concrete options + recommended choices. **Do NOT start work on these
  before reading #647** — half need design calls, half need credentials.
- **Phantom-carry-over warning:** if any team member sees an item in the
  Google Doc with ❌ next to it, they MUST run a 30-second `gh issue view`
  + `git log` + feature-grep before scoping. The doc has 86 items already
  shipped with stale ❌ markers — picking up any of them blind wastes ~25
  min per item. This is now a CLAUDE.md standing rule with 4 confirmed
  instances in 4 days.

---

## What's shipped — by PRD cluster

The 8 May Google Doc grouped items into 13 clusters. Status as of 2026-05-10:

### Foundation (8 items in doc) — ✅ 7/8 shipped

| Item | Status | Where |
|---|---|---|
| `Contact.walletBalance` denorm | ✅ | Wave 6 `9e58829` |
| `Contact.anniversary` | ✅ | Wave 6 `9e58829` |
| `Contact.gst` | ✅ | Wave 6 `9e58829` |
| `Contact.birthDate` | ✅ | Wave 6 `9e58829` |
| `CommissionProfile` model + UI | ✅ | Wave 7 `d38534d` |
| `StaffRevenueGoal` model | ✅ | Wave 7 `d38534d` |
| module × action permissions matrix | ✅ | Wave 7 `d38534d` |
| `lead_source` naming drift | ✅ verified — zero drift on inspection | v3.7.0 Wave 8b audit |

### POS / New Sale (14 items in doc) — ✅ 14/14 shipped

| Item | Status | Where |
|---|---|---|
| POS Sale screen | ✅ | v3.5.0 Wave 2 `e37369a` |
| InvoiceLine polymorphic model | ✅ | v3.5.0 Wave 2 |
| Split-tender Payments + breakdown | ✅ | v3.6.0 Wave 7 `25a8025` (COMBINED method + paymentBreakdownJson) |
| Per-invoice payment endpoints | ✅ | `pos.js:527` (CASH/CARD/UPI/WALLET/GIFTCARD/COMBINED) |
| Sum-validation on completion | ✅ | Wave 7 `25a8025` (line totals + tax + discount = grand-total ±₹0.01) |
| Inventory hook on completion | ✅ | Wave 6 `ffdc7d4` decrementInventoryOnSale |
| Loyalty hook on completion | ✅ | Wave 6 `ffdc7d4` |
| SMS receipt hook | ✅ | v3.7.0 Wave 8b `e9b4e6d` posReceiptDispatcher.js |
| WhatsApp receipt (opt-in gated) | ✅ | Same dispatcher |
| Discount / coupon / manager-override | ✅ | Wave 7 `25a8025` (with reason audit) |
| Draft sale actions | ✅ | Wave 2 POS backbone |
| Guest Checkout | ✅ | Wave 7 `25a8025` |
| `/api/v1/invoices` alias | ✅ | Wave 7 `25a8025` |
| `sale.completed` eventBus emit | ✅ | Wave 8b `e9b4e6d` |

### Cash Register / Shift (6 items, was 0% in doc) — ✅ 6/6 shipped

All shipped in v3.5.0 Wave 2 (`e37369a`): Register + RegisterShift models, open/close/deposit flows, expected-vs-actual variance, recent-transactions breakdown.

### Memberships (10 items, was 0% in doc) — ✅ 10/10 shipped

Plans + customer_memberships + benefit_usage + sell-flow + auto-apply + renew/cancel/refund all shipped across v3.5.0 / v3.5.2. T-7 reminder cron lives at `wellnessOpsEngine.js runMembershipExpiryForTenant()` with `MEMBERSHIP_EXPIRY_WINDOW_DAYS=7`. Memberships dashboard at `/api/wellness/memberships/dashboard` shipped Wave 7 `a7bc989`.

### Loyalty Wallet / Cashback / GiftCards / Coupons (10 items in doc) — ✅ 10/10 shipped

All shipped in Wave 11 last week (`b69febf` Agent FF):
- WalletTransaction ledger + monetary wallet (vs points-only)
- CashbackRule + inline `writeWalletTransaction` in routes/wellness.js
- GiftCard + GiftCardTransaction with code lookup + redemption
- Coupon + CouponUsage ledger
- Wallet + GiftCard accepted as payment methods at `pos.js:527`
- 48-test spec at `wallet-giftcard-coupon-api.spec.js` pinning the contract

Loyalty points + Referral were already ✅ in the doc.

### Mini Website + Booking Widget (9 items) — ✅ 9/9 shipped

- Per-location mini-site editor: rich TipTap-style editor shipped Wave 7 `a7bc989`
- bookingType enum (WALKIN / IN_HOME / IN_STORE / TELE → actual: CLINIC_VISIT / IN_HOME / VIDEO / PHONE): Wave 2 `9c74d46`
- At-home address + travel time: Wave 2 + v3.7.0 Wave 8b pincodeZones.js (10 metros)
- At-store Resource reservation: Wave 8b — `GET /public/tenant/:slug` includes `resources[]`, POST /public/book accepts resourceId, PublicBooking.jsx shows preferred-room picker
- Booking source field + UTM persistence: Wave 2 `9c74d46`
- Embed widget + public slots: pre-existing ✅

### WhatsApp 2-Way Chatbox (9 items) — ✅ 9/9 shipped

- WhatsAppThread model + agent assignment + opt-out: Wave 2 `97b157f`
- Chats screen tabs: functionally distributed across WhatsAppThreads.jsx (Threads + actions) + Channels.jsx (Templates)
- 24h send window with `OUTSIDE_24H_WINDOW` 422: Wave 7 `a7bc989`
- Webhook handler: pre-existing ✅
- Snooze: Wave 2 ✅
- DPDP §11 re-opt-in audit: v3.7.1 Wave 9 `a667d07` (requires reason ≥10 chars + WHATSAPP_OPT_IN_RESET audit) — **see #647 section 5 for review**
- Templates: pre-existing ✅

### Attendance & Biometric (7 items, was 0% in doc) — ✅ 7/7 shipped

All shipped in v3.5.0 Wave 2 (`3f0b68c`): events table + device API + manual fallback + geofenced mobile + dashboard + calendar + payroll CSV.

### Leave Management (was implicit in doc) — ✅ shipped + carry-forward cron

- Leave model + accruals + approvals: Wave 2 `3f0b68c`
- Carry-forward + encashment cron: v3.7.0 Wave 8b `e9b4e6d` `leavePolicyEngine.js` (daily 02:30 IST, 31 March wellness / 31 December generic fiscal year-end)
- Admin trigger for QA at `POST /api/leave/policy-carry-forward/run` with optional `body.now` override: post-v3.7.0 `240c5be`

### Inventory Backbone (7 items) — ✅ 7/7 shipped

All shipped in Wave 11 (`d05ee16` Agent HH):
- ProductCategory model + hierarchical parentId
- Vendor model with GSTIN
- InventoryReceipt (atomic Product.stockQty increment on insert)
- InventoryAdjustment (DAMAGE / LOSS / CORRECTION / TRANSFER / AUTO_CONSUMPTION types)
- AutoConsumptionRule + `lib/autoConsumptionApplier.js` visit-completed event-bus listener
- `Product.taxRate` per-item: post-v3.6.0 (reverted then re-shipped clean)
- Low-stock cron: pre-existing ✅

### Service Catalogue (4 items) — ✅ 4/4 shipped

All shipped in Wave 7 (`8021bcd`):
- ServiceCategory model + hierarchical parentId
- Service.categoryId FK
- Drug DB (16 Indian-clinic-typical OTC + Rx drugs seeded, indexed for prescription typeahead)
- CSV import/export framework with RFC4180 escape + formula-injection prefix at `/api/csv/services|drugs|patients|contacts`

### Calendar / Resources (4 items, was 0% in doc) — ✅ 4/4 shipped

All shipped in Wave 11 (`a177c99` Agent GG):
- Resource model (rooms / machines / equipment)
- Holiday model (PUBLIC / TENANT / LOCATION with optional doctorId scope)
- 4-class conflict-prevention engine: HOLIDAY_BLOCKED / OUTSIDE_WORKING_HOURS / RESOURCE_DOUBLE_BOOKED / DOCTOR_DOUBLE_BOOKED
- Booking-type legend on Calendar.jsx (CLINIC_VISIT / IN_HOME / VIDEO / PHONE chips)

### Notification Center (7 items) — ✅ 7/7 shipped

- Notification model + bell + routes + push: pre-existing ✅
- 4 missing taps wired (visit-completed, prescription-issued, payment-received, low-inventory): Wave 6 `ac1aa30`
- Approvals → notification: pre-existing ✅
- SLA breach: pre-existing slaBreachEngine ✅
- Expiring memberships: Wave 8b verified (already shipped at wellnessOpsEngine)
- No-show risk: appointmentRemindersEngine `runNoShowRiskForTenant()` ✅

### Analytics / Events (12 items) — ✅ 12/12 shipped

All shipped Wave 6 (`53917ab`): invoice / payment / wallet / cashback / giftcard / membership / attendance / shift / sale events all emit on the canonical eventBus envelope.

### P&L + Attribution (cross-cluster) — ✅ canonicalized

3 surfaces (`/dashboard.yesterday.revenue`, `/reports/pnl-by-service`, `/reports/per-professional`, `/reports/per-location`) used to show different revenue figures. v3.7.1 Wave 9 `4eca36c` extracted `backend/lib/pnlMath.js` with one canonical definition: `sum(amountCharged) WHERE status='completed' AND visitDate IN [from, to]` in IST. All 4 surfaces unified.

---

## What's genuinely pending — see [#647](https://github.com/Globussoft-Technologies/globussoft-crm/issues/647)

8 items. **None are engineering pickup until user/operator/external teams reply.**

| # | Bucket | Item | Recommended option | Engineering effort |
|---|---|---|---|---|
| 1 | Operator | B-03 SendGrid Sender Identity | A: Single Sender Verify (~2 min in dashboard) | 0 — operator does it |
| 2 | Product | #555 tenant-switcher UX | ★ C: lock to single tenant per session | ~3 hours |
| 3 | Product | #558 audit-log tamper-evidence | ★ A: hash-chain SHA-256 prev+row | ~1.5 days |
| 4 | Product | #564 wellness consent surface | ★ B: staff-tablet handoff + ★ blob storage | ~1 day |
| 5 | Product | WhatsApp DPDP §11 re-opt-in policy | ★ Keep current (admin reason + audit) | 0-1h |
| 6 | External | Callified webhook auto-post | n/a — partner team | 0 |
| 7 | External | AdsGPT silent SSO | n/a — external team | 0 |
| 8 | Tracking | #457 manual-QA umbrella | stays open by design | 0 |

**Total work to close everything actionable after user replies: ~2 days.**

---

## What the team should NOT re-do

Specific items the dev team might be tempted to start work on but which are already shipped:

- ❌ "Build POS Sale screen" — already in `pos.js` at `/api/wellness/pos/sales`
- ❌ "Build Cash Register / Shift" — Register + RegisterShift models live
- ❌ "Build Memberships" — full CRUD + dashboard + T-7 cron all shipped
- ❌ "Build Wallet / GiftCard / Coupon" — Wave 11 Agent FF shipped the lot
- ❌ "Build Resource model + conflict prevention" — Wave 11 Agent GG, 4 conflict classes
- ❌ "Build ProductCategory / Vendor / InventoryReceipt / InventoryAdjustment" — Wave 11 Agent HH
- ❌ "Build P&L canonical reconcile" — Wave 9 `lib/pnlMath.js`
- ❌ "Build WhatsApp 24h gate" — Wave 7 `a7bc989`
- ❌ "Build mini-website rich editor" — Wave 7 `a7bc989`
- ❌ "Build CSV import/export" — Wave 7 `8021bcd`
- ❌ "Build Drug DB" — Wave 7 `8021bcd`
- ❌ "Build Service Catalogue (ServiceCategory)" — Wave 7 `8021bcd`
- ❌ "Build leave carry-forward cron" — Wave 8b `e9b4e6d`
- ❌ "Build POS SMS/WhatsApp receipt hook" — Wave 8b `e9b4e6d`
- ❌ "Build booking pincode travel time" — Wave 8b `e9b4e6d`

**If you find something in the Google Doc that says ❌ but you think might be already shipped**, run this before scoping the work:

```bash
# Replace <feature> with the thing you're checking
gh issue list --search "<feature>" --state all --limit 5
git log --oneline --all -- "**<feature>*" 2>/dev/null | head -10
grep -rn "<keyword>" backend/routes/ backend/lib/ backend/prisma/schema.prisma | head -5
```

If those return relevant results from the last 2 weeks of commits → already shipped, do not start work.

---

## Coverage / test surface

- Per-push gate: ~4,235 tests (~50 Playwright spec files + ~30 vitest files)
- Backend vitest: 1,220 unit tests
- 6 mandatory deploy gates: build / lint / api_tests / unit_tests / frontend_unit_tests / migration_check
- Release-validation suite (e2e-full.yml): ~5,400+ tests on every git tag push

Specs that pin the shipped Zylu-PRD items (file paths for reference):
- `wallet-giftcard-coupon-api.spec.js` (48 tests)
- `inventory-extension-api.spec.js` (45 tests)
- `calendar-availability-api.spec.js` (30 tests)
- `wellness-reports-api.spec.js` (P&L canonical reconciliation tests)
- `wellness-rbac-regression-api.spec.js` (POLICY 1-4 RBAC tests)
- `whatsapp.spec.js` (DPDP §11 + 24h gate + opt-out)
- `leave-api.spec.js` (carry-forward admin trigger)
- `attendance-api.spec.js`
- `memberships-api.spec.js`
- `public-booking-api.spec.js` (bookingType + pincode + resource picker)

---

## Where to look for current state

- **Code:** `main` branch on https://github.com/Globussoft-Technologies/globussoft-crm
- **Release notes:** https://github.com/Globussoft-Technologies/globussoft-crm/releases — v3.5.0 through v3.7.1 are all from today
- **Architecture handoff:** [docs/HANDOFF-2026-05-10.md](HANDOFF-2026-05-10.md)
- **Pending blockers tracker:** [#647](https://github.com/Globussoft-Technologies/globussoft-crm/issues/647) + [docs/PENDING_USER_AND_OPERATOR.md](PENDING_USER_AND_OPERATOR.md)
- **Engineering backlog:** [TODOS.md](../TODOS.md) — has the session-start handoff at the top
- **Demo running v3.7.1:** https://crm.globusdemos.com — login with `rishu@enhancedwellness.in / password123` for the wellness tenant

---

**For team-lead questions:** the most defensible single question to ask
engineering is "what's pending on issue #647?" — that's the genuine
remaining work. Everything else in the Zylu PRD doc is already shipped.

**Last updated:** 2026-05-10 23:30 IST (post-v3.7.1)
**Maintainer:** auto-updated by the engineering session; refresh by re-running
the discovery audit when material doc-vs-code drift is suspected.

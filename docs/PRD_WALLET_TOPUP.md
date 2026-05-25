# PRD — Wallet Top-up Flow (Bonus Rules + Expiry + Transaction History on top of existing Wallet model)

**Status:** NOT STARTED — PRD draft only; design call required (DD-5.1 bonus-rule-precedence + DD-5.2 expiry-bucketing strategy + DD-5.3 redemption-priority + DD-5.7 reversal semantics determine the rule engine + ledger shape materially)
**Source:** GH #788 — [Zylu-Gap][WAL-001] Wallet Top-up flow with bonus rules + expiry is missing
**Tier:** P3 — Operator productivity / customer loyalty (today's wallet ledger ships the storage layer at `backend/prisma/schema.prisma:3496-3531` with `Wallet` + `WalletTransaction` models plus two admin-credit/debit endpoints at `backend/routes/wellness.js:7957` + `:7994` — but **the operator-facing TOP-UP FLOW with bonus-rule application + expiry policy + customer notification + transaction-history UI is missing**). Material when a clinic wants to run a loyalty promotion ("pay ₹2000, get ₹50 bonus") to drive repeat visits; material when the clinic accountant needs a paginated wallet-statement export for the customer; material when a 12-month-old bonus credit silently expires and the customer complains about the lost balance.
**Authored:** 2026-05-25 (tick #195 / Agent B, autonomous overnight cron arc — Bonus PRD #9 in this batch wave on top of the official 10 P3 + 8 prior bonus)
**Sibling PRDs:** `PRD_PURCHASE_ORDERS.md` (tick #187, cluster D8) · `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188, D9) · `PRD_IMPORT_EXPORT_JOBS.md` (tick #189, D10) · `PRD_INTEGRATIONS_HUB.md` (tick #190, D11) · `PRD_TAG_MASTER.md` (tick #191, D12) · `PRD_AI_CHAT_HISTORY.md` (tick #192, D13) · `PRD_CUSTOMER_SEGMENTS.md` (tick #193, D14) · `PRD_STAFF_DETAIL.md` (tick #194, D15)
**Cluster:** MANUAL_CODING_BACKLOG.md cluster D (wellness operational session) — proposing **D16**; see §10.
**Cred dependency:** none external for v1 — re-uses existing payment infra (Stripe / Razorpay cred via #896 covered in `PRD_PAYMENT_GATEWAY_CONFIG.md`). Pure internal model + endpoints + admin page + cron + patient-detail tab + 6 audit-event actions.

---

## §1 Background + source attribution

The CRM today has the WALLET STORAGE LAYER fully shipped:

- **`Wallet` model** at [backend/prisma/schema.prisma:3496-3510](../backend/prisma/schema.prisma#L3496-L3510) — per-patient + per-tenant ledger with `balance` + `currency` (defaults to `INR`) + 1:N to `WalletTransaction`.
- **`WalletTransaction` model** at [backend/prisma/schema.prisma:3512-3531](../backend/prisma/schema.prisma#L3512-L3531) — signed-amount ledger with `type` + `reason` + cross-refs to `visitId` / `invoiceId` / `giftCardId` / `couponId` + `balanceAfter` snapshot + `performedBy` audit-trail field.
- **Two ADMIN-only endpoints** at [backend/routes/wellness.js:7957-8033](../backend/routes/wellness.js#L7957) — `POST /api/wellness/wallet/:walletId/credit` + `POST /api/wellness/wallet/:walletId/debit` — manual admin credit/debit only; no bonus-rule application, no expiry-timer, no customer-facing flow.
- **`writeWalletTransaction()` helper + `getOrCreateWallet()` helper** at [backend/routes/wellness.js:7888-7935](../backend/routes/wellness.js#L7888) — atomic balance-update + ledger-write inside a Prisma transaction; reused for the new top-up flow.
- **`CashbackRule` model** at [backend/prisma/schema.prisma:3586-3599](../backend/prisma/schema.prisma#L3586-L3599) — sibling rule engine for per-service cashback (NOT top-up bonus); pattern reused for the new `WalletBonusRule` model.

**What's missing (per GH #788):**

1. **Customer-facing top-up form** — operator says "₹2000 top-up" at the front desk; today they call the admin-credit endpoint manually; no payment-collection step + no bonus-rule application + no receipt + no SMS confirmation.
2. **Bonus rule engine** — Zylu's "pay ₹500 → get ₹50 bonus" / "pay ₹2000 → get ₹200 bonus" pattern. No model + no rule precedence + no scheduling (validFrom / validTo).
3. **Expiry policy** — bonus credits should expire (e.g. 12 months from top-up) so the clinic doesn't carry a perpetual liability. Principal credits MAY expire too (per Q5 — recommend NO; principal is the customer's money).
4. **Redemption priority** — when customer redeems ₹500 at a Visit, which bucket pays first — principal or bonus? Determines expiry-aware customer-fairness vs liability-flush economics.
5. **Expiry cron** — daily sweep that moves expired bonus credits from `LIVE` to `EXPIRED` state + emits customer notification.
6. **Reversal flow** — what happens when a top-up is refunded (payment-gateway chargeback / operator cancellation)? Need a `REVERSAL` transaction type + bonus-credit clawback semantics.
7. **Transaction history UI** — paginated wallet statement on the Patient detail page; today operators can only query the raw `walletTransaction` table.
8. **Admin rule management page** — CRUD for `WalletBonusRule`; preview which rule applies for an amount; toggle active.
9. **Customer notification on expiry** — T-7d and T-0 SMS/WhatsApp/email to the customer; ties into existing `notificationService.js` + `routes/sms.js` infrastructure.

Per GH issue #788 verbatim:

> **Priority:** Medium
>
> **Current state:** Wallet storage models (`Wallet` + `WalletTransaction`) ship in `schema.prisma`. Two admin-credit/debit endpoints exist on `wellness.js`. No operator-facing top-up form, no bonus-rule engine, no expiry policy.
>
> **Gap:**
> Compared to Zylu (the salon CRM reference cited in #788), the missing capabilities are:
> - Top-up form (operator captures amount + payment method + applies active bonus rule)
> - `WalletBonusRule` model with min-amount + bonus-percent + validity-months + active toggle + validFrom/validTo
> - Bonus-bucket vs principal-bucket tracking (so principal isn't auto-expired)
> - Expiry cron that sweeps bonus credits past their expiry timestamp
> - Customer notification 7d before expiry + on expiry
> - Transaction-history paginated UI on patient detail
> - Reversal flow (chargeback / cancellation) including bonus clawback
>
> **Requirements:**
> - Per-tenant scoping; idempotency on top-up POST; atomicity inside a single Prisma transaction.
> - Audit log: `WALLET_TOPUP`, `WALLET_REDEEM`, `WALLET_EXPIRY`, `WALLET_REVERSAL`, `WALLET_RULE_CHANGED`, `WALLET_BALANCE_VIEWED` events.
> - RBAC: USER reads own wallet; cashier (USER + sub-role) can top-up + redeem; ADMIN configures rules.
> - Re-use existing `notificationService.js` + `routes/sms.js` for customer SMS confirmation.
>
> **Impact:** Operator workflow is manual + leaky; no loyalty-driver mechanism for repeat visits; bonus-credit liability accrues indefinitely with no expiry; customer surprised when wallet shows ₹0 after silent expiry.
>
> **Notes:** Reuse existing `Wallet` + `WalletTransaction` models. Add `WalletBonusRule` + extend `WalletTransaction.type` enum to include bonus-bucket types. Mirror `CashbackRule` model shape.

### Today's wallet flow (the gap)

1. **Customer visits, pays ₹2000 for a top-up** — front-desk operator opens `POST /api/wellness/wallet/:walletId/credit` via a sidebar admin tool OR (in practice) does NOT use it because the operator UX doesn't surface it cleanly.
2. **Top-up succeeds (or doesn't)** — no payment-gateway integration, no SMS receipt, no bonus credit, no rule application.
3. **Customer redeems** — `walletTransaction` type=`DEBIT` row gets created when a Visit checkout uses wallet payment (today via manual call to `/wallet/:walletId/debit`). No expiry-awareness — debit reduces the SAME balance pool that mixes principal + bonus.
4. **Months pass** — no engine moves bonus credits to EXPIRED state; clinic carries perpetual liability; operator has no visibility into what's principal vs what's bonus.
5. **Customer asks for refund of unused balance** — operator has no reversal flow; manually does a `DEBIT` (with comment "refund") + cuts a cheque off-system. No audit-trail of the refund.

### Zylu reference pattern (prior art)

Zylu's wallet flow ships:
- Top-up form on customer detail page + at POS checkout: `[Amount] [Payment Method] [Active Bonus: ₹50 will be added]` + receipt SMS.
- Bonus rules: "Tier 1 (₹500-₹1999): 5% bonus" / "Tier 2 (₹2000+): 10% bonus" / "Birthday Boost: 15% on the birthday month" — multiple active rules with operator-defined precedence.
- Expiry: bonus credits expire 12 months from top-up (per-rule configurable); principal credits never expire.
- Redemption priority: principal first (FIFO of top-ups), then bonus (FIFO of expiry-soonest-first) — customer-fair (operator's principal-cash gets used last so it can be refunded if needed).
- Expiry cron: nightly sweep; 7-day-before SMS reminder + on-expiry SMS.
- Statement UI: paginated table with running balance, transaction type pill, source-rule (for bonus rows), expiry countdown.

### Source attribution

- GH issue #788 — [https://github.com/Globussoft-Technologies/globussoft-crm/issues/788](https://github.com/Globussoft-Technologies/globussoft-crm/issues/788)
- `backend/prisma/schema.prisma:3496-3531` — existing `Wallet` + `WalletTransaction` models (storage layer, shipped)
- `backend/routes/wellness.js:7888-8033` — existing wallet helpers + 2 admin endpoints
- `backend/routes/wellness.js:8478` — existing `CashbackRule` CRUD; pattern reused for `WalletBonusRule`
- `backend/lib/notificationService.js` — re-used for customer expiry-warning notifications
- `backend/routes/sms.js` — re-used for SMS receipt + expiry-warning delivery
- `backend/lib/audit.js` `writeAudit()` — new `WALLET_*` action set flows through the existing tamper-evident chain
- `backend/cron/` (22 engines today) — new `walletExpiryEngine.js` joins the family
- Payment integration: `PRD_PAYMENT_GATEWAY_CONFIG.md` (D9) — top-up POST passes the `paymentMethod` through to the existing Stripe / Razorpay flow

### Why this isn't a "small wallet patch" — it's a rule engine + ledger refactor

The existing `WalletTransaction.amount` is a single `Float` per row with no notion of bucket (principal vs bonus). To support expiry, we need to PARTITION the running balance into LIVE buckets (principal + bonus-with-expiry) such that redemption can debit the right bucket without crossing the partition.

Two design paths (per DD-5.2):
- **(a) BUCKET-COLUMN on existing `WalletTransaction`** — add `bucket String` ('PRINCIPAL' | 'BONUS') column + `expiresAt DateTime?` column + balanceAfterPrincipal / balanceAfterBonus columns. Compact; minor schema bloat; queries get heavier.
- **(b) SIBLING `WalletCreditBatch` MODEL** — every top-up creates ONE `WalletCreditBatch` for principal + (if applicable) ONE for bonus; each batch has remaining-balance + expiresAt; redemption walks live batches in priority order (DD-5.3) and decrements per-batch. Cleaner FIFO + per-rule attribution; one extra table; redemption write-amplification (1 transaction can hit 3-5 batches).

Path (b) is the recommended pattern — it makes the expiry-bucket math first-class and supports the Zylu-grade "your ₹500 bonus from May 14 is expiring on July 7" customer-facing detail. Path (a) would force every reporting query to re-derive bucket totals via accumulated SUM-with-CASE — slower + error-prone over time.

---

## §2 Use cases

1. **Customer top-up at front desk: ₹2000 cash → ₹2000 wallet principal + ₹200 bonus per active "10% bonus on ₹2000+" rule.** Operator (role=USER + sub-role=cashier OR role=MANAGER) navigates to a patient's detail page → Wallet tab → "Top-up" button → modal opens: enter `amount=2000`, select `paymentMethod=cash`, review the rule-preview pane showing "₹200 bonus will be added per rule 'Tier 2: 10% on ₹2000+'", confirm. Backend creates 1 `WalletCreditBatch` (principal, no expiry) + 1 `WalletCreditBatch` (bonus, expiresAt=now+12mo, sourceRuleId=2) + 1 `WalletTransaction` (type=`TOPUP`, amount=2200, reason="Cash top-up + Tier 2 bonus") atomically in a single Prisma transaction. Audit chain captures `WALLET_TOPUP { walletId, principalCents, bonusCents, ruleId, paymentMethod, idempotencyKey }`. Customer receives SMS receipt: "Wallet credited ₹2200 (₹2000 + ₹200 bonus, expires 2027-05-25). Balance: ₹3450."

2. **ADMIN configures a new bonus rule "Festive: 15% on ₹3000+".** ADMIN navigates `/admin/wallet-rules` → "New rule" → fills name=`Festive Boost`, minAmountCents=300000, bonusPercent=15, validityMonths=12, validFrom=`2026-10-15`, validTo=`2026-11-15`, active=true, precedence=10 (higher than the existing 5% / 10% tiers). Saves. Audit chain captures `WALLET_RULE_CHANGED { ruleId, action: 'CREATED', diff }`. For top-ups during the Festive window, the engine applies Tier 2 (10%) AND Festive (15%) — both match — but only ONE wins per DD-5.1. Recommendation: HIGHEST-PERCENT-WINS (Festive 15% wins over Tier 2 10%). Alternative paths in DD-5.1.

3. **Customer redeems wallet balance at a Visit checkout.** Customer's wallet has 3 LIVE batches: B1=₹500 principal (no expiry) from Apr-12, B2=₹2000 principal (no expiry) from May-25, B3=₹200 bonus (expires 2027-05-25) from May-25. Visit checkout charges ₹600 to wallet. Per DD-5.3 (principal-first + expiry-soonest-bonus-first): the engine debits B1=₹500 (now empty, status=`CONSUMED`) + B2=₹100 (₹1900 remains). Creates 2 `WalletDebit` ledger rows + 1 `WalletTransaction` (type=`REDEEM`, amount=-600, visitId=X). Bonus batch B3 stays untouched (still ₹200 + expiry=2027-05-25). Audit chain captures `WALLET_REDEEM { walletId, visitId, debitedBatches: [{id: 1, cents: 50000}, {id: 2, cents: 10000}], remainingBalance: 210000 }`.

4. **Operator views wallet transaction history per patient.** Operator opens Patient detail → Wallet tab. Page renders: current balance (₹2100 — principal ₹1900 + bonus ₹200), a "Top-up" button (gated to cashier+), and a paginated transactions table with columns: date / type-pill / amount (signed; green for credit, red for debit) / source (rule name for bonus, visit-link for redeem, refund-reason for reversal) / running-balance / expiry-countdown (only for bonus rows). Operator clicks pagination → backend returns next page from `GET /api/wallet/transactions?patientId=X&page=2&limit=25`.

5. **Auto-expire engine sweeps expired bonus credits monthly; sends customer notification 7d before.** Nightly cron `backend/cron/walletExpiryEngine.js` runs at 03:30 IST. Phase 1: find all bonus `WalletCreditBatch` where `expiresAt BETWEEN now AND now+7d` AND `warning7dSentAt IS NULL` → send T-7d notification ("Your ₹200 bonus expires on 2027-05-25. Use at your next visit."). Phase 2: find all bonus batches where `expiresAt <= now` AND `status='LIVE'` → mark `status='EXPIRED'`, write `WalletTransaction` (type=`EXPIRY`, amount=-200, reason="12-month bonus expiry, rule: Tier 2"), send T-0 notification ("Your ₹200 bonus has expired."). Each phase is paginated (1000 batches per tick); idempotent if the cron is killed mid-run.

6. **Refund flow — operator cancels a top-up; wallet reverses principal + claws back bonus.** Customer disputes a ₹2000 cash top-up done 3 days ago. ADMIN navigates to the wallet transaction history → finds the original `WALLET_TOPUP` row → clicks "Reverse". Modal: "This will reverse the principal credit AND claw back the unredeemed bonus. If bonus has been partially redeemed, only the unredeemed portion is clawed back. Continue?" Per DD-5.7 (clawback-only-unredeemed-portion): the engine debits B2 (₹2000 principal) by however much is REMAINING (₹1900 in the post-redeem state) + debits B3 (₹200 bonus) by however much is REMAINING (₹200, untouched) = total reversal credit ₹2100. If the customer's redeemed ₹100 from this batch is non-refundable (per DD-5.7), the reversal is `₹1900 principal + ₹200 bonus` returned via the operator's chosen refund mechanism (cash / payment-gateway). Audit chain captures `WALLET_REVERSAL { originalTransactionId, reversedPrincipalCents: 190000, clawbackBonusCents: 20000, residualConsumedByVisitId: X, paymentRefundMethod: 'cash' }`.

---

## §3 Functional requirements

### FR-3.1 New Prisma model `WalletBonusRule` + extended `WalletTransaction.type` enum + new `WalletCreditBatch` model

```prisma
model WalletBonusRule {
  id              Int      @id @default(autoincrement())
  tenantId        Int      @default(1)
  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name            String   // operator-facing label, e.g. "Tier 2: 10% on ₹2000+"
  minAmountCents  Int      // top-up principal must be >= this for the rule to apply
  bonusPercent    Float    // 5.0 = 5%, 12.5 = 12.5% — applied to principal (NOT to existing bonus stacks)
  validityMonths  Int      @default(12) // bonus credit expires N months from top-up date
  precedence      Int      @default(0)  // higher precedence wins per DD-5.1 (a) operator-defined-order
  active          Boolean  @default(true)
  validFrom       DateTime? // rule-window start (NULL = always-from-now)
  validTo         DateTime? // rule-window end (NULL = always-until-deactivated)
  notes           String?  @db.Text     // ADMIN notes
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  createdByUserId Int?
  lastEditedByUserId Int?

  @@unique([tenantId, name])
  @@index([tenantId, active, validFrom, validTo])
}

model WalletCreditBatch {
  id                Int      @id @default(autoincrement())
  tenantId          Int      @default(1)
  tenant            Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  walletId          Int
  wallet            Wallet   @relation(fields: [walletId], references: [id], onDelete: Cascade)

  bucket            String   // 'PRINCIPAL' | 'BONUS'
  originalCents     Int      // credit amount on creation (cents in wallet.currency)
  remainingCents    Int      // decremented on redemption; reaches 0 when batch is CONSUMED
  status            String   @default("LIVE") // 'LIVE' | 'CONSUMED' | 'EXPIRED' | 'REVERSED'

  expiresAt         DateTime? // NULL for principal (DD-5.5 path a; principal never expires); set for bonus
  warning7dSentAt   DateTime? // set when T-7d notification fires (idempotency)
  expiredAt         DateTime? // set when status flips to EXPIRED

  // Provenance — what created this batch?
  sourceTransactionId Int?   // FK to WalletTransaction (the TOPUP / ADJUSTMENT row that created it)
  sourceRuleId      Int?     // FK to WalletBonusRule (only for bucket='BONUS')
  sourceRule        WalletBonusRule? @relation(fields: [sourceRuleId], references: [id])

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([tenantId, walletId, status, expiresAt]) // primary redemption query
  @@index([tenantId, status, expiresAt])           // expiry-engine sweep
  @@index([sourceTransactionId])                    // reversal lookups
}

// WalletTransaction.type — extend the enum (today: ad-hoc strings) to include:
//   'TOPUP'      — operator-collected top-up (principal credit + optional bonus credit)
//   'REDEEM'     — visit / invoice debit
//   'EXPIRY'     — bonus credit expiry (debit; engine-generated)
//   'REVERSAL'   — top-up refund (principal + bonus clawback; operator-initiated)
//   'ADJUSTMENT' — manual ADMIN credit/debit (existing 2 endpoints)
// No migration needed (existing column is `type String`; this PRD just locks the vocabulary).
// WalletTransaction.amount stays signed-float (existing); meta extends optionally with batch debits.
```

Additive only (zero data migration). Existing `Wallet` + `WalletTransaction` models stay unchanged. New models are nullable-FK-bound to existing models. Passes `migration_check` gate without bless markers.

### FR-3.2 New top-up endpoint — `POST /api/wallet/topup`

```
POST /api/wallet/topup
Headers: Authorization: Bearer <token>; Idempotency-Key: <uuid>
Body: {
  patientId: Int,
  amountCents: Int,             // principal in tenant default currency cents
  paymentMethod: 'cash' | 'card' | 'upi' | 'gateway' | 'cheque',
  paymentReference?: String,    // operator-supplied receipt# / gateway txn id
  applyRuleId?: Int             // operator-override; default = engine picks per DD-5.1
}
Response 200: {
  walletId,
  transaction: { id, type: 'TOPUP', amount, balanceAfter },
  principalBatch: { id, originalCents, expiresAt: null },
  bonusBatch: { id, originalCents, expiresAt, ruleId, ruleName } | null,
  newBalanceCents: Int,
  smsQueuedNotificationId?: Int
}
Response 4xx: VALIDATION / IDEMPOTENCY_REPLAY (cached prior response returned)
```

**Auth:** `verifyToken` + `verifyRole(['ADMIN', 'MANAGER', 'USER'])` + sub-role check for USER (must be `cashier` or `receptionist` per FR-3.6). All callers must belong to the same tenant as the target patient.

**Engine flow:**
1. Validate body via `express-validator` (positive amount; valid paymentMethod enum; idempotencyKey UUID format).
2. Look up Patient by id + tenantId scope; return 404 if not found.
3. `getOrCreateWallet(req, patientId)` — re-uses existing helper.
4. Determine bonus rule: if `applyRuleId` supplied, fetch + validate it's active + within validity window; else apply DD-5.1 precedence rule (HIGHEST-PERCENT-WINS recommended) over all active+in-window rules where `amountCents >= rule.minAmountCents`.
5. Inside ONE Prisma transaction: write `WalletTransaction` (type=TOPUP, signed-positive); write `WalletCreditBatch` (bucket=PRINCIPAL, no expiry); if rule applied, write `WalletCreditBatch` (bucket=BONUS, expiresAt=now+rule.validityMonths); update `Wallet.balance += (principal + bonus)`.
6. Outside the transaction: write audit `WALLET_TOPUP`; enqueue SMS receipt via existing `notificationService.js` (if tenant has SMS configured AND patient.smsOptIn).
7. Return envelope.

**Idempotency:** mirror the payment-idempotency pattern (lookup `IdempotencyKey` model — if not yet shipped, add a stub Redis-or-DB cache per DD-5.6); replay returns cached response with 200 + `replayed: true` flag.

### FR-3.3 New redemption endpoint — `POST /api/wallet/redeem`

```
POST /api/wallet/redeem
Body: {
  patientId: Int,
  amountCents: Int,
  reason: 'VISIT' | 'INVOICE' | 'ADJUSTMENT',
  visitId?: Int,                // required if reason=VISIT
  invoiceId?: Int,              // required if reason=INVOICE
  idempotencyKey: String
}
Response 200: {
  transaction: { id, type: 'REDEEM', amount: -amountCents, balanceAfter },
  debitedBatches: [{ batchId, bucket, cents, remainingCents }, ...],
  newBalanceCents
}
Response 4xx: INSUFFICIENT_BALANCE { availableCents } | VALIDATION
```

**Auth:** `verifyToken` (any role; the visit checkout flow drives this).

**Engine flow:** Inside ONE Prisma transaction: read all `WalletCreditBatch` for the wallet with `status='LIVE' AND remainingCents > 0` ordered by DD-5.3 priority (recommended: principal-FIFO + bonus-soonest-expiry-FIFO). Walk batches; decrement `remainingCents`; if it hits 0 flip status to `CONSUMED`. Sum the total debited; if < amountCents, ROLLBACK + return `INSUFFICIENT_BALANCE { availableCents: <total-live-cents> }`. Else: write `WalletTransaction` (type=REDEEM, signed-negative, visitId/invoiceId set); update `Wallet.balance -= amountCents`; return envelope. Audit `WALLET_REDEEM`.

### FR-3.4 Transaction history endpoint — `GET /api/wallet/transactions`

```
GET /api/wallet/transactions?patientId=X&page=1&limit=25&type=TOPUP|REDEEM|EXPIRY|REVERSAL|ADJUSTMENT
Response 200: {
  transactions: [{
    id, type, amount, balanceAfter, reason, createdAt, performedBy,
    visitId?, invoiceId?,
    batchDebitDetails?: [{ batchId, bucket, cents, sourceRuleName? }],  // for REDEEM rows
    sourceRuleName?,                                                     // for TOPUP rows that applied a rule
    expiryBatchId?                                                       // for EXPIRY rows
  }, ...],
  pagination: { page, limit, total },
  walletBalance: { totalCents, principalCents, bonusCents, nextExpiryAt? }
}
```

Auth: `verifyToken` + RBAC scope (USER reads own; cashier+ reads any in tenant per FR-3.6). Audit `WALLET_BALANCE_VIEWED` (throttled per the EMPLOYEE_PROFILE_VIEWED pattern from PRD_STAFF_DETAIL.md — once per (session-id, patientId) per 5 min).

### FR-3.5 Expiry cron — `backend/cron/walletExpiryEngine.js`

New engine #23 (after `segmentEvaluationEngine.js` from `PRD_CUSTOMER_SEGMENTS.md`). Daily cron at 03:30 IST. Two-phase sweep:

- **Phase 1 (T-7d warning):** Find batches where `bucket='BONUS' AND status='LIVE' AND expiresAt BETWEEN now AND now+7d AND warning7dSentAt IS NULL`. For each, enqueue SMS via `notificationService.js`; set `warning7dSentAt=now()`; audit `WALLET_EXPIRY_WARNING_SENT`.
- **Phase 2 (T-0 expiry):** Find batches where `bucket='BONUS' AND status='LIVE' AND expiresAt <= now AND remainingCents > 0`. For each, inside ONE transaction: flip `status='EXPIRED'`; set `expiredAt=now()`; write `WalletTransaction` (type=EXPIRY, signed-negative=−remainingCents, reason="12-month bonus expiry, rule: <name>"); decrement `Wallet.balance`; set batch `remainingCents=0`. Audit `WALLET_EXPIRY`. Enqueue T-0 SMS.

Each phase paginated (1000 rows per tick); engine is restartable (idempotent; uses `warning7dSentAt` + `expiredAt` set-once guards).

**Admin trigger endpoint** (mirror G-9 / G-10 pattern from CLAUDE.md): `POST /api/wallet/expiry/run` (`verifyRole(['ADMIN'])`) — drains both phases synchronously and returns the count. Used for deterministic e2e tests.

### FR-3.6 Admin page — `frontend/src/pages/admin/WalletRules.jsx` for rule CRUD + active-rule preview

- **Route registration** in `frontend/src/App.jsx`: `/admin/wallet-rules`. Lazy-loaded.
- **Sidebar entry:** ADMIN-only — under "Settings" group.
- **List view:** table of all `WalletBonusRule` rows; columns name / minAmount / bonusPercent / validity / validFrom / validTo / precedence / active toggle / Edit-link. Filters: active=true|false; sortable on precedence.
- **Edit modal:** all fields editable; active-toggle with confirm; "Preview" pane that takes a hypothetical amount and shows which rule would apply.
- **Reorder UI:** drag-to-reorder for `precedence`-ordered display (when DD-5.1 path b operator-defined-order). Higher = priority.
- **Audit feed:** "Last 10 changes" footer surfacing recent `WALLET_RULE_CHANGED` audit rows.

### FR-3.7 Patient Wallet tab — `frontend/src/pages/wellness/PatientDetail.jsx` (existing 7-tab structure gains an 8th tab)

- **Tab title:** "Wallet" (only visible if tenant has wallet feature enabled; toggle via `Tenant.walletEnabled Boolean @default(true)` Phase 2 if needed).
- **Header strip:** total balance + breakdown ("Principal ₹1900 + Bonus ₹200 (expires in 11mo, 3wk)").
- **Action buttons:** "Top-up" (gated to cashier+ per FR-3.6 RBAC) + "Refund" (gated to ADMIN).
- **Transaction table:** paginated; columns date / type-pill / amount / reason / running-balance / source (rule name for bonus or visit-link for redeem) / expiry-countdown (only for bonus rows).
- **Expiry warning banner:** if any bonus batch expires in <30d, surface a banner: "₹200 bonus expires in 23 days — use at your next visit."

### FR-3.8 Audit log integration — 6 new audit actions

All flow through existing `backend/lib/audit.js` `writeAudit()` for tamper-evident hashing. Audit entity = `WALLET`.

- `WALLET_TOPUP` — fields: walletId, principalCents, bonusCents, ruleId, paymentMethod, paymentReference, idempotencyKey
- `WALLET_REDEEM` — fields: walletId, visitId, invoiceId, totalCents, debitedBatches[]
- `WALLET_EXPIRY` — fields: walletId, batchId, expiredCents, ruleId (engine-generated)
- `WALLET_EXPIRY_WARNING_SENT` — fields: walletId, batchId, daysBefore=7, notificationId (engine-generated; throttled to once per batch)
- `WALLET_REVERSAL` — fields: originalTransactionId, walletId, reversedPrincipalCents, clawbackBonusCents, residualConsumedCents, paymentRefundMethod
- `WALLET_RULE_CHANGED` — fields: ruleId, action='CREATED'|'UPDATED'|'DEACTIVATED', diff
- `WALLET_BALANCE_VIEWED` — fields: walletId, patientId (throttled per the EMPLOYEE_PROFILE_VIEWED pattern)

Retention: `WALLET_*` events flow through the standard `retentionEngine.js` (default 365d, per-tenant configurable). NOT marked indefinite (different from EMPLOYEE_*_VIEWED on PRD_STAFF_DETAIL.md — wallet is not a statutory-record retention class).

### FR-3.9 RBAC matrix

| Action | USER (self) | USER (other) | USER (cashier sub-role) | MANAGER | ADMIN |
|--------|-------------|--------------|--------------------------|---------|-------|
| `GET /api/wallet/transactions?patientId=self` | YES | — | YES | YES | YES |
| `GET /api/wallet/transactions?patientId=other` | NO (403) | NO | YES (any in tenant) | YES | YES |
| `POST /api/wallet/topup` | NO (403) | — | YES | YES | YES |
| `POST /api/wallet/redeem` | NO (route is visit-checkout-internal) | — | YES | YES | YES |
| `POST /api/wallet/reverse/:txnId` | NO | — | NO | NO | YES |
| `POST /api/wallet/expiry/run` (admin trigger) | NO | — | NO | NO | YES |
| `GET /api/wallet/rules` | NO | — | NO | YES (read) | YES |
| `POST /api/wallet/rules` (CRUD) | NO | — | NO | NO | YES |

Cross-tenant access always 404 (existence-disclosure prevention; same pattern as EmployeeProfile in PRD_STAFF_DETAIL.md).

### FR-3.10 Reversal endpoint — `POST /api/wallet/reverse/:txnId`

```
POST /api/wallet/reverse/:txnId
Body: { reason: String, paymentRefundMethod: 'cash' | 'gateway' | 'cheque' | 'wallet_residual' }
Response 200: { reversedTransaction, residualConsumedCents, refundCents, paymentRefundMethod }
Response 4xx: TXN_NOT_REVERSIBLE (already reversed; original txn wasn't a TOPUP; > N days old per DD-5.7)
```

Per DD-5.7: clawback only the UNREDEEMED portion of the original top-up's batches. Residual consumed by visits is non-refundable (operator option to compensate via cash if business demands — out of scope of this engine).

Audit `WALLET_REVERSAL`. SMS notification to customer ("Your top-up of ₹2000 has been reversed; ₹1900 refunded via cash + ₹200 bonus clawed back.").

---

## §4 Non-functional

- **Per-tenant scoping enforced.** Every endpoint scopes by `req.user.tenantId`; cross-tenant access returns 404.
- **Idempotency.** All `POST /topup` + `/redeem` + `/reverse` calls require `Idempotency-Key` header (UUID). Cached responses replay for 24h (DD-5.6 — DB-backed `IdempotencyKey` model or Redis).
- **Atomicity.** Principal credit + bonus credit + ledger row + balance update all go through inside ONE Prisma transaction. Failure rolls back the wallet to pre-call state.
- **Cron cadence.** `walletExpiryEngine.js` daily at 03:30 IST. Configurable via env var `WALLET_EXPIRY_CRON_SCHEDULE` (defaults to `30 3 * * *`).
- **Notification cadence.** T-7d warning once per batch (set-once via `warning7dSentAt`); T-0 expiry once per batch (set-once via `expiredAt`). No double-sends.
- **Read latency.** Wallet detail load (FR-3.7) P95 target <500ms — single Prisma query with `_count` + paginated transactions + summed batches. Transactions page with 25 rows ≈ 100ms.
- **Write latency.** Top-up P95 <800ms (Prisma transaction + audit-chain + SMS-enqueue; SMS-dispatch is fire-and-forget via job queue).
- **Storage cost.** Per top-up: 1 transaction row (~200 bytes) + 1-2 batch rows (~150 bytes each) = ~500 bytes. Per active patient with monthly top-ups over 2 years = ~24 * 500 = 12 KB. Across 10K patients = ~120 MB. Negligible.
- **Mobile responsive.** Top-up modal stacks vertically <768px. Transactions table degrades to card list.
- **i18n-ready.** All operator + customer-facing labels route through `LanguageSwitcher.jsx`. Rule names + reason strings are user-content (NOT translated).
- **Multi-currency awareness.** All amounts are stored in `wallet.currency` cents (default INR). Top-up form respects the tenant's `defaultCurrency`; cross-currency top-ups out-of-scope (Q7).
- **Backward compatibility.** Existing 2 admin-credit/debit endpoints at `wellness.js:7957` continue to work (mapped to `WalletTransaction.type='ADJUSTMENT'`). Existing rows have no `WalletCreditBatch` provenance; the engine treats them as legacy principal (LIVE, no expiry) implicit-batches via a one-shot migration script in slice 1.
- **PHI policy.** Wallet data is OPERATOR-OWNED + customer-financial; outside the PHI gate (which covers patient clinical data). NOT gated by `phiReadGate`; IS gated by RBAC scope per FR-3.9.

---

## §5 Hand-over reqs / cred chase / design decisions / vendor docs

### Design decisions (require product / engineering sign-off before any code lands)

- **DD-5.1 Bonus rule precedence — HIGHEST-PERCENT-WINS (current proposal) vs operator-defined-order vs all-stacked.** Three paths:
  - **(a) HIGHEST-PERCENT-WINS (current proposal).** Engine picks the rule with the highest `bonusPercent` among all active+in-window rules where `amountCents >= rule.minAmountCents`. Pro: simple; predictable; ties (same percent) break on `validTo` soonest. Con: operator can't override (must adjust percentages to control rollout).
  - **(b) OPERATOR-DEFINED-ORDER.** Each rule has `precedence Int` (already in FR-3.1 schema); engine picks highest precedence among matching. Pro: full operator control. Con: more cognitive load; operators may forget to set precedence on new rules.
  - **(c) ALL-STACKED.** Sum bonuses from all matching rules. Pro: "campaign + Festive" boost is operator-natural. Con: economically dangerous (operator stacks 10% + 15% + 20% = 45% bonus on a single top-up); customer-confusing; hard to debug.
  - **Recommendation: (a) HIGHEST-PERCENT-WINS for v1; revisit (b) if operators ask for explicit override control after running for 3-6 months.** Schema already supports both (precedence column exists for future flip).

- **DD-5.2 Bucket-tracking strategy — sibling `WalletCreditBatch` model (current proposal) vs bucket-columns on existing `WalletTransaction`.** Two paths:
  - **(a) SIBLING `WalletCreditBatch` (current proposal, FR-3.1).** New model per top-up principal + per top-up bonus. Pro: first-class FIFO; per-rule attribution; clean expiry-engine sweep. Con: 1 extra table; redemption write-amplification (1 transaction → 3-5 batch updates).
  - **(b) BUCKET-COLUMNS on `WalletTransaction`.** Add `bucket String`, `expiresAt DateTime?`, `principalBalanceAfter`, `bonusBalanceAfter`. Pro: no new table. Con: redemption math requires accumulated SUM-with-CASE; partial-batch debits hard to express; expiry-engine sweep is N×M joins.
  - **Recommendation: (a) SIBLING `WalletCreditBatch`.** First-class abstraction; matches Zylu pattern; supports the "your ₹200 bonus from May 14 is expiring on July 7" customer detail; performance is fine because per-redeem batch count is typically 1-5.

- **DD-5.3 Redemption priority — principal-FIFO + bonus-soonest-expiry-FIFO (current proposal) vs bonus-first + principal-last vs hybrid operator-choice.** Three paths:
  - **(a) PRINCIPAL-FIFO + BONUS-SOONEST-EXPIRY (current proposal).** Debits principal batches FIFO (oldest first); then bonus batches by soonest expiry. Pro: customer-fair (principal is their own money; the clinic doesn't preserve its own liability at customer expense); operator's principal-cash gets used last so it can be cleanly refunded if needed. Con: bonus credits stay in the pool longer (more expiry-cron work; more customer expiry-warnings).
  - **(b) BONUS-FIRST + PRINCIPAL-LAST.** Debits bonus batches FIFO by soonest expiry first; principal last. Pro: flushes the clinic's bonus liability faster; reduces expiry cron load. Con: customer-unfriendly (the customer's own money sits unused while the clinic burns through its bonus liability); reversal flow becomes messy (if customer refunds, the bonus is already consumed).
  - **(c) HYBRID OPERATOR-CHOICE.** Per-tenant flag `walletRedemptionPriority` ('PRINCIPAL_FIRST' | 'BONUS_FIRST'). Pro: tenant-flexibility. Con: surface complexity; tracking which tenants opted in becomes ops complexity.
  - **Recommendation: (a) PRINCIPAL-FIFO + BONUS-SOONEST-EXPIRY for v1.** Customer-fair default; Zylu match.

- **DD-5.4 SMS confirmation on top-up — YES (current proposal) vs opt-in vs operator-toggle.** Three paths:
  - **(a) SMS ALWAYS on top-up (current proposal).** Customer gets SMS receipt immediately. Pro: instant fraud-detection (customer who didn't expect a top-up will know); customer confidence. Con: SMS cost (~₹0.20/msg) at scale.
  - **(b) OPT-IN per patient.** Customer's `smsOptIn` flag drives. Pro: respects customer preference. Con: most opt-out by default (operator-set); silent top-up surprises customer if it goes wrong.
  - **(c) PER-TENANT OPERATOR-TOGGLE.** Tenant flag `walletSmsOnTopupEnabled`. Pro: tenant-flexibility. Con: surface complexity.
  - **Recommendation: (a) SMS ALWAYS for v1.** Customer-protection beats SMS cost; if cost becomes painful, flip to (c) operator-toggle in Phase 2.

- **DD-5.5 Principal expiry — NEVER (current proposal) vs configurable per-tenant vs 24-month default.** Three paths:
  - **(a) PRINCIPAL NEVER EXPIRES (current proposal).** Only bonus credits expire; principal is the customer's money. Pro: customer-fair; legally simple (treating principal as a long-term liability mirrors prepaid retail). Con: clinic carries a perpetual liability on the books.
  - **(b) CONFIGURABLE per-tenant.** `Tenant.walletPrincipalExpiryMonths Int? @default(null)` — NULL = never. Pro: tenant-flexibility. Con: customer-trust risk if tenant flips it on retroactively.
  - **(c) 24-MONTH HARD DEFAULT.** Principal expires 24mo after last activity. Pro: matches some retail prepaid laws (e.g. US "12 months from purchase OR 6 months from last activity"). Con: legally fraught in India; jurisdictionally varying.
  - **Recommendation: (a) PRINCIPAL NEVER EXPIRES for v1.** Legally safe; customer-friendly; revisit (b) if a tenant explicitly asks for expiry (only with strong customer-notification flow first).

- **DD-5.6 Idempotency storage — DB-backed `IdempotencyKey` model (current proposal) vs Redis cache vs reuse existing payment-idempotency.** Three paths:
  - **(a) NEW DB-BACKED `IdempotencyKey` MODEL.** New table; per-tenant; cached for 24h via TTL cron. Pro: durable across restarts; no Redis dependency. Con: DB write-amplification on every POST.
  - **(b) REDIS CACHE.** SETEX with 24h TTL. Pro: fast; no DB load. Con: new Redis ops dependency.
  - **(c) REUSE existing payment-idempotency mechanism.** If `PRD_PAYMENT_GATEWAY_CONFIG.md` (D9) ships an `IdempotencyKey` model, reuse it. Pro: one source-of-truth. Con: cross-PRD coupling.
  - **Recommendation: (c) REUSE if D9 has shipped by then; else (a) DB-backed for v1.** Phase 2 may flip to (b) Redis if write-volume warrants.

- **DD-5.7 Reversal semantics — clawback-only-unredeemed (current proposal) vs full-reversal vs operator-choice.** Three paths:
  - **(a) CLAWBACK-ONLY-UNREDEEMED (current proposal).** Reverse the unredeemed remaining portion; residual consumed by visits is non-refundable. Pro: customer-fair (they already used the bonus on a visit; the visit can't be un-done). Con: operator must explain to customer "we can refund ₹1900 of the ₹2000, the other ₹100 was used at visit X".
  - **(b) FULL-REVERSAL + VISIT-CHARGE-BACK.** Reverse the full ₹2000 + ADD a `WalletTransaction` debit on the visit (re-charging the visit to a different payment method). Pro: clean separation; visit becomes regular-pay. Con: complex; requires patient cooperation to settle the new visit charge.
  - **(c) OPERATOR-CHOICE on the reversal modal.** Operator picks (a) or (b) at reversal time. Pro: flexibility. Con: surface complexity; risk of choosing wrong path.
  - **Recommendation: (a) CLAWBACK-ONLY-UNREDEEMED for v1.** Simpler; matches retail prepaid pattern.

- **DD-5.8 Loyalty tier integration — separate Phase 2 feature (current proposal) vs unified into WalletBonusRule.** Two paths:
  - **(a) SEPARATE Phase 2 LoyaltyTier model.** Phase 2 ships `LoyaltyTier` (Bronze/Silver/Gold thresholds) + `Patient.tierComputed` cron; tier modifies the `WalletBonusRule.bonusPercent` per-customer at top-up time. Pro: clean separation; Phase 1 ships value; Phase 2 layers loyalty on top. Con: deferred capability.
  - **(b) UNIFIED into WalletBonusRule via tier-conditional rules.** Each rule has `applicableTiers String[]?`; engine evaluates patient tier first then matches rules. Pro: ships everything in v1. Con: schema bloat; tier-computation cron becomes a v1 dependency.
  - **Recommendation: (a) SEPARATE Phase 2.** Avoid v1 scope creep; ship the top-up + bonus + expiry core cleanly first.

### Cred chase

- **None external for v1.** Re-uses existing payment-gateway integration (Stripe / Razorpay cred via #896 — `PRD_PAYMENT_GATEWAY_CONFIG.md` cluster D9).
- **None external for SMS** — uses existing `services/smsProvider.js` (MSG91 / Twilio cred already deployed).

### Vendor docs

- N/A for v1. Internal pattern reuse only.
- **Internal doc dependency:** the `frontend/src/pages/admin/WalletRules.jsx` header JSDoc documents the rule-precedence + edit-modal flow.
- **Internal doc dependency:** the `backend/cron/walletExpiryEngine.js` header JSDoc documents the two-phase sweep + idempotency guards.
- **Internal doc dependency:** the `frontend/src/pages/wellness/PatientDetail.jsx` Wallet-tab JSDoc documents the per-row meta surface (rule-name for bonus rows, visit-link for redeem rows).

---

## §6 Acceptance criteria

- **AC-6.1** Cashier (USER + cashier sub-role) navigates Patient detail → Wallet tab → "Top-up" → enters amount=2000 INR + paymentMethod=cash → confirms. Backend creates 1 `WalletTransaction` (type=TOPUP, amount=+2200), 1 `WalletCreditBatch` (PRINCIPAL, 200000 cents, no expiry), 1 `WalletCreditBatch` (BONUS, 20000 cents, expiresAt=now+12mo, sourceRuleId=2 with name="Tier 2: 10% on ₹2000+") inside one Prisma transaction. `Wallet.balance` increments by 220000 cents. Audit chain captures `WALLET_TOPUP` with all batch metadata. SMS receipt is enqueued via `notificationService.js` for the patient's phone. The same POST with the same `Idempotency-Key` header within 24h returns the cached response with `replayed: true`.

- **AC-6.2** Cashier triggers `POST /api/wallet/redeem` for a Visit checkout of ₹600 against a wallet with batches [B1=₹500 PRINCIPAL Apr-12, B2=₹2000 PRINCIPAL May-25, B3=₹200 BONUS May-25/expires 2027-05-25]. Engine debits B1=₹500 (flipped to CONSUMED) + B2=₹100 (₹1900 remaining LIVE). B3 untouched. `WalletTransaction` (type=REDEEM, amount=-60000, visitId=X) created. `Wallet.balance` decrements by 60000. Audit `WALLET_REDEEM { debitedBatches: [{id: B1, cents: 50000}, {id: B2, cents: 10000}] }`. A second redeem attempt for ₹100K against the remaining ₹2100 wallet returns 400 `INSUFFICIENT_BALANCE { availableCents: 210000 }` and rolls back.

- **AC-6.3** ADMIN triggers `POST /api/wallet/expiry/run`. Engine finds 3 BONUS batches with `expiresAt <= now AND status='LIVE'`. For each: status → EXPIRED, expiredAt set, `WalletTransaction` (type=EXPIRY, signed-negative) created, Wallet balance decremented. Audit `WALLET_EXPIRY ×3`. Subsequent re-run of the endpoint within 1 minute is a no-op (idempotent; no batches now match the predicate). T-7d warning batches in phase 1 are set-once via `warning7dSentAt`; running the endpoint twice does NOT double-send SMS.

- **AC-6.4** ADMIN navigates `/admin/wallet-rules` → creates a new rule "Festive Boost: 15% on ₹3000+, validityMonths=6, validFrom=2026-10-15, validTo=2026-11-15, precedence=100, active=true". A subsequent top-up of ₹3000 within the Festive window applies the Festive rule (15%) and writes `WalletCreditBatch.bonusBatch.sourceRuleId=<festiveId>` + `originalCents=45000`. Outside the window, the engine falls back to the Tier 2 (10%) rule. Audit `WALLET_RULE_CHANGED { ruleId, action: 'CREATED', diff }`.

- **AC-6.5** ADMIN triggers `POST /api/wallet/reverse/:txnId` against an earlier top-up `WalletTransaction` with PRINCIPAL batch (₹2000 → ₹1900 remaining after ₹100 visit-redeem) + BONUS batch (₹200 untouched). Engine: principal batch reversed by ₹1900 (status=REVERSED, remainingCents=0); bonus batch reversed by ₹200 (status=REVERSED, remainingCents=0); 2 `WalletTransaction` rows (type=REVERSAL, signed-negative) created; Wallet.balance decrements by 210000 cents. Audit `WALLET_REVERSAL { reversedPrincipalCents: 190000, clawbackBonusCents: 20000, residualConsumedCents: 10000, paymentRefundMethod: 'cash' }`. SMS notification enqueued. Cross-tenant access to this endpoint: tenant-A ADMIN tries to reverse a tenant-B `WalletTransaction.id` → 404 (existence-disclosure prevention).

---

## §7 Out of scope

- **Cross-tenant wallet portability** — Phase 3 feature (federated wallet across multiple clinics in a chain). v1 is single-tenant only.
- **Gift-card model integration** — `GiftCard` model exists separately at `schema.prisma:3533`. Gift-card redemption is a sibling surface; v1 wallet does NOT auto-convert gift cards into wallet credit. Phase 2 considers a "redeem gift card → wallet credit" affordance.
- **Coupon-bound top-up promotions** — `Coupon` model exists separately at `schema.prisma:3566`. v1 bonus rules are amount-based only; coupon-code-driven bonuses ("enter code BOOST500 to get extra ₹50") are Phase 2.
- **Cashback model integration** — `CashbackRule` model exists separately at `schema.prisma:3586` for per-service earning. Wallet bonus rules (this PRD) are top-up-driven; cashback rules are visit-driven. Both can be active independently. Phase 2 considers a unified "earning surface".
- **Loyalty tier promotion engine** — Per DD-5.8 deferred to Phase 2; `LoyaltyTier` model + tier-conditional bonus rules.
- **Multi-currency wallets** — v1 ships single-currency-per-tenant (`Wallet.currency` defaults to tenant.defaultCurrency). Per Q7 deferred to Phase 2.
- **Wallet transfer between patients** — Per Q3 deferred to Phase 2; needs gift-or-share semantics + audit-trail design.
- **Cash-out / withdrawal** — Per Q4 deferred to Phase 2; refund-policy + KYC implications need product call.
- **Negative-balance / overdraft** — Per Q2 explicitly disallowed in v1 (`INSUFFICIENT_BALANCE` error). Phase 2 considers tenant-configurable overdraft limits.
- **Wallet-statement PDF export** — Phase 2 (mirror `PRD_IMPORT_EXPORT_JOBS.md` async export pattern; >1000 transactions warrants async job).
- **Customer-portal self-top-up** — Phase 2 (customer logs into `routes/portal.js` + tops up via payment gateway without operator). Requires public-facing payment surface + KYC.
- **Off-system wallet reconciliation** (legacy wallet balances imported from a prior system) — Phase 2 import job.
- **Travel-vertical wallet** — TMC trip-deposit-and-balance flows. Phase 2 — separate `PRD_TRAVEL_WALLET.md`.
- **AI fraud detection on top-up pattern** — Phase 3 (e.g. "this top-up looks anomalous — confirm?"). Out of scope.
- **Wallet limit caps (max balance, max top-up)** — Phase 2; `Tenant.walletMaxBalanceCents` + `Tenant.walletMaxTopupPerDayCents` per-tenant flags.

---

## §8 Dependencies

- **`Wallet` model** at `backend/prisma/schema.prisma:3496-3510` — re-used as-is; no field changes. The `balance` field is now the sum-of-batches-remaining derived total; cached for read performance but recomputable.
- **`WalletTransaction` model** at `backend/prisma/schema.prisma:3512-3531` — re-used as-is; the `type` column gains new vocabulary (`TOPUP` / `REDEEM` / `EXPIRY` / `REVERSAL` / `ADJUSTMENT`) without schema change (existing column is `String`).
- **`Patient` model** — re-used as-is (no field changes; wallet FK already exists).
- **`backend/routes/wellness.js:7888-7935`** `writeWalletTransaction()` + `getOrCreateWallet()` helpers — re-used as low-level primitives by the new `routes/wallet.js`.
- **`backend/lib/notificationService.js`** — re-used for SMS top-up receipts + expiry warnings + reversal notifications.
- **`backend/services/smsProvider.js`** — re-used as the SMS dispatcher (MSG91 / Twilio cred already deployed).
- **`backend/lib/audit.js` `writeAudit()`** — new `WALLET_*` action set flows through the existing tamper-evident chain.
- **`backend/middleware/auth.js`** `verifyToken` + `verifyRole` — gates the new endpoints.
- **`backend/routes/staff.js`** (existing) — extended optionally to surface a "Cashier" sub-role badge per FR-3.6.
- **`backend/routes/audit.js`** `/verify` endpoint — accepts the WALLET_* event family without code change (entity = `WALLET`).
- **`backend/cron/`** — new `walletExpiryEngine.js` joins as engine #23 (after `segmentEvaluationEngine.js`); registered in `server.js` cron-init block. Honours `DISABLE_CRONS=1` env-flag for the local-stack-only e2e specs.
- **Idempotency mechanism** — either (a) new DB-backed `IdempotencyKey` model OR (c) reuse the existing model from `PRD_PAYMENT_GATEWAY_CONFIG.md` (D9). Per DD-5.6.
- **`PRD_PAYMENT_GATEWAY_CONFIG.md` (D9)** — when top-up paymentMethod=`gateway`, the top-up POST routes through the configured Stripe / Razorpay flow. v1 may ship cash-only first if D9 isn't ready.
- **New file `backend/routes/wallet.js`** — 7 endpoints per FR-3.2 to FR-3.10.
- **New file `backend/lib/walletRuleEngine.js`** — `pickBonusRule(amountCents, tenantId)` + `applyBonus(amountCents, rule)` helpers + DD-5.1 precedence logic.
- **New file `backend/lib/walletRedemption.js`** — `redeem(walletId, amountCents)` + DD-5.3 priority logic (batch walker).
- **New file `backend/cron/walletExpiryEngine.js`** — two-phase sweep per FR-3.5.
- **New file `frontend/src/pages/admin/WalletRules.jsx`** — admin CRUD page (rule list + edit modal + preview pane).
- **New file `frontend/src/lib/walletApi.js`** — client-side API helpers (`topup` / `redeem` / `transactions` / `reverse` / `rulesGet` / `rulesPost`).
- **Wallet-tab extension** to `frontend/src/pages/wellness/PatientDetail.jsx` — adds 8th tab; conditional on tenant feature flag (always-on in v1).
- **CI gate-spec wiring** — `e2e/tests/wallet-api.spec.js` added to both `.github/workflows/deploy.yml` and `.github/workflows/coverage.yml` gate-spec lists per the `wiring-spec-into-gate` skill.
- **Vitest unit tests** at `backend/test/lib/walletRuleEngine.test.js` + `backend/test/lib/walletRedemption.test.js` + `backend/test/cron/walletExpiryEngine.test.js` per the `writing-vitest-unit-test` skill.

---

## §9 Open questions

- **Q1 Bonus stacking behaviour — strict HIGHEST-PERCENT-WINS (current proposal, DD-5.1) or operator-defined-order (precedence column) or per-rule additive (stacked)?** Recommend HIGHEST-PERCENT-WINS for v1; revisit operator-defined-order in Phase 2 if real demand surfaces. Stacking is economically dangerous and customer-confusing. Confirm.

- **Q2 Negative balances / overdraft — strict positive-only (current proposal) or tenant-configurable overdraft limit?** Recommend strict positive-only — return 400 `INSUFFICIENT_BALANCE` when redemption exceeds available cents. Overdraft creates a receivable that has no engine. Phase 2 considers per-tenant overdraft caps. Confirm.

- **Q3 Wallet transfer between patients — supported?** Recommend NO for v1 — gift-or-share-wallet semantics need a separate design (gift-card model already exists for that; wallet is per-patient). Phase 2 considers if real demand surfaces. Confirm.

- **Q4 Cash-out / withdrawal — customer wants ₹2000 wallet back as cash. Allowed?** Recommend NO direct cash-out from v1 wallet; refund flow only (`POST /api/wallet/reverse/:txnId` on an existing top-up). Direct withdrawal needs KYC + refund-policy design. Phase 2. Confirm.

- **Q5 Expiry calendar — bonus 12 months default; per-rule configurable (current proposal) or per-tenant configurable or one global default?** Recommend per-rule configurable via `WalletBonusRule.validityMonths` (FR-3.1 schema). What's the right default — 12 months (current) or 6 months (more aggressive expiry) or 24 months (more customer-friendly)? Recommend 12 months. Confirm.

- **Q6 Loyalty tier (Gold/Silver) layering on top of bonus rules — same surface or new?** Per DD-5.8 recommend Phase 2 separate `LoyaltyTier` model. v1 ships amount-based rules only. Confirm — or push back if loyalty tiers need to ship simultaneously (would expand v1 scope by ~3 eng-days).

- **Q7 Multi-currency wallets — single-currency-per-tenant (current proposal) or per-wallet currency override?** Recommend single-currency-per-tenant (matches tenant.defaultCurrency). Per-wallet override has cross-currency conversion semantics that need product call. Phase 2. Confirm.

- **Q8 Reversal cutoff — how many days after a top-up can it be reversed?** No-cutoff path: allow reversal forever. Conservative path: only within 30d to prevent ledger churn. Recommend: no-cutoff in v1 but flag reversals >30d in audit; revisit Phase 2 if abuse surfaces. Confirm.

- **Q9 Bonus expiry vs principal — does principal ever expire?** Per DD-5.5 recommend NEVER for v1. Confirm — or push back if a tenant has a specific compliance reason needing 24-month principal expiry.

- **Q10 SMS template + branding** — exact text of top-up receipt SMS ("Wallet credited ₹2200 (₹2000 + ₹200 bonus, expires 2027-05-25). Balance: ₹3450.") + T-7d warning SMS ("Your ₹200 bonus expires on 2027-05-25. Use at your next visit.") + T-0 expiry SMS + reversal SMS. Need operator + customer-facing copy review.

- **Q11 Reversal payment-refund-method — cash / gateway / cheque / wallet_residual (offset against future top-ups)?** Recommend operator-selects at reversal time (FR-3.10 body field). `wallet_residual` (customer keeps the balance for future use, no cash out) is an interesting compromise — worth confirming as a default for chargeback-protected gateway flows.

---

## §10 Status snapshot

**Status:** NOT STARTED — PRD draft only; design call required to lock DD-5.1 (bonus rule precedence) + DD-5.2 (bucket-tracking strategy) + DD-5.3 (redemption priority) + DD-5.7 (reversal semantics) + Q5 (expiry months default) + Q9 (principal-expiry policy) before any code lands. **DD-5.2 (sibling `WalletCreditBatch` model vs bucket-columns on existing `WalletTransaction`) is the highest-leverage decision** — it determines the data model shape + query patterns + redemption algorithm across the entire surface.

**Owner:** TBD per product call. Likely allocation:

- Prisma `WalletBonusRule` + `WalletCreditBatch` models + WalletTransaction type-vocab lock (additive nullable, passes `migration_check` gate) — backend engineer ~0.5 day
- One-shot legacy-data migration script (existing rows → implicit-batch creation) — backend engineer ~0.5 day
- `backend/lib/walletRuleEngine.js` (rule selection per DD-5.1) + `walletRedemption.js` (batch walker per DD-5.3) — backend engineer ~0.75 day
- `backend/routes/wallet.js` (7 endpoints per FR-3.2 to FR-3.10) — backend engineer ~1.5 days
- `backend/cron/walletExpiryEngine.js` (two-phase sweep + admin trigger endpoint) — backend engineer ~0.75 day
- Idempotency wiring (DD-5.6 path a or c) — backend engineer ~0.5 day
- Notification + SMS integration (top-up receipt + expiry warning + expiry + reversal) — backend engineer ~0.5 day
- Audit log integration (FR-3.8 — 7 new event actions wired through `writeAudit()`) — backend engineer ~0.25 day
- Frontend `frontend/src/pages/admin/WalletRules.jsx` (rule list + edit modal + preview pane + audit feed) — frontend engineer ~1 day
- Frontend Patient detail Wallet tab (8th tab on existing 7-tab structure) — frontend engineer ~1 day
- Frontend top-up modal + redeem flow + reversal modal — frontend engineer ~0.75 day
- Frontend RBAC field-hiding + cashier sub-role detection — frontend engineer ~0.25 day
- Tests (api-spec for 7 endpoints + RBAC matrix + idempotency replay + vitest for rule engine + redemption batch walker + expiry engine) — backend engineer ~1.25 days
- Wiring into `coverage.yml` + `deploy.yml` gate-spec lists — backend engineer ~0.25 day

**Total estimated effort post-design: 4-6 engineering days** (rule engine + 7 endpoints + admin page + cron + patient-detail tab + idempotency wiring + tests — matches the cred-chase-free, model-already-shipped baseline).

**Sibling PRDs in this cluster:**

- `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape, cluster D8)
- `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment-side integration governance, cluster D9; DEPENDED ON for idempotency model + gateway top-up flow)
- `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops, cluster D10; future wallet-statement PDF export flows through here)
- `PRD_INTEGRATIONS_HUB.md` (tick #190 — unified discovery / status / governance surface, cluster D11)
- `PRD_TAG_MASTER.md` (tick #191 — controlled-vocabulary governance, cluster D12)
- `PRD_AI_CHAT_HISTORY.md` (tick #192 — unified AI audit + recall surface, cluster D13)
- `PRD_CUSTOMER_SEGMENTS.md` (tick #193 — saved-filter audience targeting, cluster D14)
- `PRD_STAFF_DETAIL.md` (tick #194 — HR profile extension, cluster D15)

**Blocks before frontend impl can start:**

- DD-5.1 (bonus rule precedence) — MUST resolve (engine flow)
- DD-5.2 (bucket-tracking — sibling model vs bucket-columns) — MUST resolve (data model shape; HIGHEST-LEVERAGE)
- DD-5.3 (redemption priority — principal-first vs bonus-first vs operator-choice) — MUST resolve (engine flow + customer fairness)
- DD-5.7 (reversal semantics — clawback-only-unredeemed vs full-reversal-and-visit-charge-back) — MUST resolve (reversal UX)
- Q1 (bonus stacking — current proposal HIGHEST-PERCENT-WINS) — MUST resolve (tied to DD-5.1)
- Q5 (expiry months default) — MUST resolve (rule schema default)
- Q9 (principal expiry policy) — MUST resolve (tied to DD-5.5; legal review needed for non-(a) paths)

**Other DDs / OQs can iterate during implementation.**

**First implementation slice recommendation:**

- **Slice 1** (~1.5 days): Prisma `WalletBonusRule` + `WalletCreditBatch` models + WalletTransaction type-vocab lock + one-shot legacy migration script + `walletRuleEngine.js` (DD-5.1) + `walletRedemption.js` (DD-5.3) + 3 of 7 endpoints (POST topup + POST redeem + GET transactions) + idempotency + audit `WALLET_TOPUP` / `_REDEEM` / `_BALANCE_VIEWED` events + api-spec tests for 3 endpoints. Ships the core ledger flow.

- **Slice 2** (~1 day): `walletExpiryEngine.js` cron + admin trigger endpoint (`POST /api/wallet/expiry/run`) + notification integration (T-7d + T-0 SMS) + audit `WALLET_EXPIRY` / `WALLET_EXPIRY_WARNING_SENT` events + api-spec tests + vitest. Ships the expiry surface.

- **Slice 3** (~0.75 day): Reversal endpoint (`POST /api/wallet/reverse/:txnId`) + audit `WALLET_REVERSAL` event + SMS notification + api-spec tests. Ships the refund surface.

- **Slice 4** (~1 day): Admin rules endpoint set (`GET/POST/PUT /api/wallet/rules`) + audit `WALLET_RULE_CHANGED` event + api-spec tests. Ships the rule CRUD API.

- **Slice 5** (~2 days): Frontend `WalletRules.jsx` (admin CRUD page) + Patient detail Wallet tab (8th tab) + top-up modal + redeem flow + reversal modal + RBAC field-hiding per FR-3.9. Ships the operator-facing UI.

- **Slice 6** (~0.5 day): vitest for `walletRuleEngine.js` + `walletRedemption.js` + `walletExpiryEngine.js` + CI gate-spec wiring (`coverage.yml` + `deploy.yml`).

Slices 1 + 2 + 3 + 4 must ship in order (each depends on the prior). Slice 5 + 6 can ship in parallel after slice 4 if dispatched file-disjoint.

**Cluster placement in `MANUAL_CODING_BACKLOG.md`:** This work fits cluster D (the wellness operational session — wallet top-up + bonus + expiry is a wellness-first capability, but wallet-as-payment-method is vertical-agnostic and helps every tenant; wellness gets the most leverage because repeat-visit-driven loyalty is core to the salon/clinic business model). Proposal: add a new entry **D16. Wallet Top-up Flow (#788)** under cluster D — sibling to D8 (Purchase Orders), D9 (Payment Gateway Config), D10 (Import/Export Jobs), D11 (Integrations Hub), D12 (Tags Master), D13 (AI Chat History), D14 (Customer Segments), D15 (Staff/Employee Detail). Cross-references to D9 (Payment Gateway Config — gateway top-ups route through D9's payment surface; shared idempotency model per DD-5.6) + D10 (Import/Export Jobs — wallet-statement PDF export Phase 2 flows through async job infra) + D13 (AI Chat History — Phase 2 AI "explain my wallet balance" customer-portal flow) + D14 (Customer Segments — Phase 2 "patients with bonus expiring in 30d" segment for proactive SMS campaigns).

**Cross-PRD coordination check:** Before implementation starts, confirm:

- `routes/audit.js` `/verify` endpoint accepts the WALLET_* event family without code change (entity = `WALLET` per FR-3.8).
- `lib/notificationService.js` accepts the new wallet notification templates (`WALLET_TOPUP_RECEIPT` / `WALLET_EXPIRY_WARNING_7D` / `WALLET_EXPIRY_T0` / `WALLET_REVERSAL_NOTIFICATION`).
- `services/smsProvider.js` SMS-send flow respects the per-patient `smsOptIn` flag for marketing-type messages but DOES dispatch transactional messages (top-up receipt + reversal) regardless (per Q10 product call).
- `cron/` directory registers `walletExpiryEngine.js` in `server.js`'s cron-init block; honours `DISABLE_CRONS=1`.
- Existing `routes/wellness.js:7957` (admin credit endpoint) continues to work (mapped to `ADJUSTMENT` type; creates an implicit principal batch).
- Existing `WalletTransaction` rows from before this PRD ships get a one-shot migration: each is treated as a legacy principal batch (`bucket='PRINCIPAL', expiresAt=null, status='LIVE', remainingCents=amount`).
- `frontend/src/pages/wellness/PatientDetail.jsx` (existing 7-tab structure) gracefully extends to 8 tabs without breaking existing tab routes.
- Idempotency model (DD-5.6 path a) — if PRD_PAYMENT_GATEWAY_CONFIG.md (D9) hasn't shipped the model yet, this PRD's slice 1 ships it; otherwise this PRD reuses D9's model.
- `Tenant.walletEnabled Boolean @default(true)` — Phase 2 feature flag to disable wallet entirely per tenant; v1 ships always-on (no flag).
- The 8th Wallet tab on PatientDetail respects the existing PHI-gate pattern (NOT gated by `phiReadGate` — wallet is financial, not clinical).

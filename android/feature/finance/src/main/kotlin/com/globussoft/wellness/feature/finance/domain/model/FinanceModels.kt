package com.globussoft.wellness.feature.finance.domain.model

// ─── POS models ───────────────────────────────────────────────────────────────

/**
 * A single line-item in a POS sale.
 *
 * [lineType] — SERVICE / PRODUCT / MEMBERSHIP / PACKAGE / GIFT_CARD
 * [lineDiscount] — per-line discount amount (not percentage); defaults to 0.
 */
data class PosLineItem(
    val lineType: String,
    val name: String,
    val qty: Int,
    val unitPrice: Double,
    val lineDiscount: Double = 0.0,
) {
    /** Effective subtotal after per-line discount. */
    val subtotal: Double get() = (unitPrice * qty) - lineDiscount
}

/**
 * Full payload submitted when completing a POS sale.
 */
data class PosSubmitRequest(
    val patientId: String?,
    val lineItems: List<PosLineItem>,
    val paymentMethod: String,
    val discountTotal: Double,
    val finalAmount: Double,
    val notes: String,
)

/**
 * Minimal receipt data returned after a successful POS sale.
 */
data class PosReceiptData(
    val invoiceNumber: String,
    val finalAmount: Double,
    val paymentMethod: String,
)

// ─── Wallet models ────────────────────────────────────────────────────────────

/**
 * Patient wallet: current balance plus the full ledger of transactions.
 */
data class WalletData(
    val patientId: String,
    val balance: Double,
    val transactions: List<WalletTransaction>,
)

/**
 * Individual wallet ledger entry.
 *
 * [type] — CREDIT or DEBIT
 * [balanceAfter] — running balance snapshot after this transaction.
 */
data class WalletTransaction(
    val id: String,
    val type: String,
    val amount: Double,
    val notes: String?,
    val createdAt: String,
    val balanceAfter: Double,
)

// ─── Gift Card models ─────────────────────────────────────────────────────────

/**
 * A prepaid gift card issued by the clinic.
 *
 * [status] — ACTIVE / REDEEMED / EXPIRED / CANCELLED
 * [redeemedAt] — ISO-8601 timestamp; null when status != REDEEMED.
 */
data class GiftCard(
    val id: String,
    val code: String,
    val amount: Double,
    val status: String,
    val createdAt: String,
    val redeemedAt: String?,
)

// ─── Coupon models ────────────────────────────────────────────────────────────

/**
 * A discount coupon that can be applied at POS checkout.
 *
 * [discountType] — PERCENT or FLAT
 * [minOrderAmount] — minimum order value required to apply the coupon; null means no minimum.
 * [maxRedemptions] — maximum total uses; null means unlimited.
 * [expiryDate] — ISO-8601 date; null means no expiry.
 * [redemptionCount] — number of times the coupon has been used so far.
 */
data class Coupon(
    val id: String,
    val code: String,
    val discountType: String,
    val amount: Double,
    val minOrderAmount: Double?,
    val maxRedemptions: Int?,
    val expiryDate: String?,
    val isActive: Boolean,
    val redemptionCount: Int,
)

/**
 * Preview result showing the discount math for a code applied to a test amount.
 */
data class CouponPreview(
    val originalAmount: Double,
    val discountAmount: Double,
    val finalAmount: Double,
)

// ─── Payment models ───────────────────────────────────────────────────────────

/**
 * A payment record returned by GET /api/payments.
 *
 * [gateway] — stripe / razorpay / cash / other
 * [status]  — PENDING / PAID / FAILED / REFUNDED
 * [paidAt]  — ISO-8601 timestamp; null when status != PAID.
 */
data class PaymentItem(
    val id: String,
    val invoiceId: String?,
    val amount: Double,
    val currency: String,
    val gateway: String,
    val status: String,
    val paidAt: String?,
    val createdAt: String,
)

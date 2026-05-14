package com.globussoft.wellness.feature.finance.domain.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.finance.domain.model.Coupon
import com.globussoft.wellness.feature.finance.domain.model.CouponPreview
import com.globussoft.wellness.feature.finance.domain.model.GiftCard
import com.globussoft.wellness.feature.finance.domain.model.PaymentItem
import com.globussoft.wellness.feature.finance.domain.model.PosReceiptData
import com.globussoft.wellness.feature.finance.domain.model.PosSubmitRequest
import com.globussoft.wellness.feature.finance.domain.model.WalletData

/**
 * Repository interface for the Finance feature module.
 *
 * Covers four sub-domains:
 * - **POS** — shift management and sale submission
 * - **Wallet** — patient prepaid wallet balances and ledger
 * - **Gift Cards** — issuance and status filtering
 * - **Coupons** — CRUD and discount-preview
 *
 * All operations return [WResult] so callers handle success, loading, and
 * error uniformly without try/catch at the ViewModel layer.
 */
interface FinanceRepository {

    // ─── POS ──────────────────────────────────────────────────────────────────

    /**
     * Opens a new register shift with the given [openingFloat] cash amount.
     * Returns [WResult.Success] with Unit on success.
     */
    suspend fun openShift(registerId: String, openingFloat: Double): WResult<Int>

    /**
     * Closes the shift identified by [shiftId].
     * [closingAmount] is the physical cash counted in the drawer.
     * [notes] captures any end-of-shift remarks.
     */
    suspend fun closeShift(shiftId: Int, closingAmount: Double, notes: String): WResult<Unit>

    /**
     * Submits a completed POS sale and returns a [PosReceiptData] with the
     * generated invoice number on success.
     */
    suspend fun submitSale(sale: PosSubmitRequest): WResult<PosReceiptData>

    // ─── Wallet ───────────────────────────────────────────────────────────────

    /**
     * Fetches the current wallet balance and full transaction ledger for
     * the given [patientId].
     */
    suspend fun getWallet(patientId: String): WResult<WalletData>

    // ─── Gift Cards ───────────────────────────────────────────────────────────

    /**
     * Returns all gift cards, optionally filtered by [status].
     * [status] — null for all, or one of: ACTIVE / REDEEMED / EXPIRED / CANCELLED.
     */
    suspend fun getGiftCards(status: String? = null): WResult<List<GiftCard>>

    /**
     * Issues a new gift card for the given face-value [amount].
     * Returns the newly created [GiftCard] with its unique code.
     */
    suspend fun issueGiftCard(amount: Double): WResult<GiftCard>

    // ─── Coupons ──────────────────────────────────────────────────────────────

    /** Returns all coupons for the current tenant. */
    suspend fun getCoupons(): WResult<List<Coupon>>

    /**
     * Creates a new coupon using the provided field map.
     * Expected keys: code, discountType, amount, minOrderAmount?, maxRedemptions?,
     * expiryDate?, isActive.
     */
    suspend fun createCoupon(params: Map<String, Any>): WResult<Coupon>

    /**
     * Updates an existing coupon identified by [id].
     * [params] contains only the fields to change.
     */
    suspend fun updateCoupon(id: String, params: Map<String, Any>): WResult<Coupon>

    /** Deletes the coupon with the given [id]. */
    suspend fun deleteCoupon(id: String): WResult<Unit>

    /**
     * Previews the discount math for applying coupon [code] to a hypothetical
     * order of [amount].
     */
    suspend fun previewCoupon(code: String, amount: Double): WResult<CouponPreview>

    // ─── Payments ─────────────────────────────────────────────────────────────

    /** Returns all payment records for the current tenant. */
    suspend fun getPayments(): WResult<List<PaymentItem>>
}

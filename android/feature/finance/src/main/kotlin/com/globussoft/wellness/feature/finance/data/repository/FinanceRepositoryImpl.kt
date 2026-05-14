package com.globussoft.wellness.feature.finance.data.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.finance.domain.model.Coupon
import com.globussoft.wellness.feature.finance.domain.model.CouponPreview
import com.globussoft.wellness.feature.finance.domain.model.GiftCard
import com.globussoft.wellness.feature.finance.domain.model.PosLineItem
import com.globussoft.wellness.feature.finance.domain.model.PosReceiptData
import com.globussoft.wellness.feature.finance.domain.model.PosSubmitRequest
import com.globussoft.wellness.feature.finance.domain.model.WalletData
import com.globussoft.wellness.feature.finance.domain.model.WalletTransaction
import com.globussoft.wellness.feature.finance.domain.repository.FinanceRepository
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Production implementation of [FinanceRepository].
 *
 * Maps flat [Map]<String, Any> API envelopes to typed domain models inline —
 * there are no separate mapper files because these models are finance-specific
 * and have no caching layer.  All operations are network-only (no Room cache)
 * since financial records must always reflect the server's authoritative state.
 *
 * ### Endpoint conventions
 * - POS:        GET  /pos/registers, GET /pos/shifts/current
 *               POST /pos/shifts/open, POST /pos/shifts/{id}/close, POST /pos/sales
 * - Wallet:     GET  /wellness/patients/{patientId}/wallet  → {patient, wallet, transactions}
 * - Gift cards: GET/POST /wellness/giftcards
 * - Coupons:    GET/POST/PUT/DELETE /wellness/coupons, POST /wellness/coupons/preview
 */
@Singleton
class FinanceRepositoryImpl @Inject constructor(
    private val api: WellnessApi,
) : FinanceRepository {

    // ─── POS ──────────────────────────────────────────────────────────────────

    override suspend fun openShift(registerId: String, openingFloat: Double): WResult<Int> =
        safeApiCall {
            api.openShift(
                mapOf(
                    "registerId"   to registerId,
                    "openingFloat" to openingFloat,
                )
            )
        }.mapSuccess { data ->
            (data["id"] as? Number)?.toInt() ?: (data["shiftId"] as? Number)?.toInt() ?: 0
        }

    override suspend fun closeShift(shiftId: Int, closingAmount: Double, notes: String): WResult<Unit> =
        safeApiCall {
            api.closeShift(
                shiftId,
                mapOf(
                    "closingAmount" to closingAmount,
                    "notes"         to notes,
                )
            )
        }.mapSuccess { }

    override suspend fun submitSale(sale: PosSubmitRequest): WResult<PosReceiptData> =
        safeApiCall {
            api.submitPosSale(sale.toApiMap())
        }.mapSuccess { data ->
            PosReceiptData(
                invoiceNumber = data["invoiceNumber"] as? String ?: "",
                finalAmount   = (data["finalAmount"] as? Number)?.toDouble() ?: 0.0,
                paymentMethod = data["paymentMethod"] as? String ?: "",
            )
        }

    // ─── Wallet ───────────────────────────────────────────────────────────────

    override suspend fun getWallet(patientId: String): WResult<WalletData> =
        safeApiCall { api.getWallet(patientId) }
            .mapSuccess { data ->
                // Backend returns { patient: {...}, wallet: {...}, transactions: [...] }
                val wallet = data["wallet"] as? Map<*, *>
                WalletData(
                    patientId    = patientId,
                    balance      = (wallet?.get("balance") as? Number)?.toDouble() ?: 0.0,
                    transactions = (data["transactions"] as? List<*>)
                        ?.filterIsInstance<Map<*, *>>()
                        ?.map { it.toWalletTransaction() }
                        ?: emptyList(),
                )
            }

    // ─── Gift Cards ───────────────────────────────────────────────────────────

    override suspend fun getGiftCards(status: String?): WResult<List<GiftCard>> =
        safeApiCall { api.getGiftCards(status) }
            .mapSuccess { envelope ->
                @Suppress("UNCHECKED_CAST")
                val rows = (envelope["giftCards"] ?: envelope["data"]) as? List<*>
                    ?: envelope.values.filterIsInstance<List<*>>().firstOrNull()
                    ?: emptyList<Any>()
                rows.filterIsInstance<Map<*, *>>().map { it.toGiftCard() }
            }

    override suspend fun issueGiftCard(amount: Double): WResult<GiftCard> =
        safeApiCall { api.issueGiftCard(mapOf("amount" to amount)) }
            .mapSuccess { data ->
                (data as? Map<*, *>)?.toGiftCard()
                    ?: GiftCard(
                        id         = "",
                        code       = "",
                        amount     = amount,
                        status     = "ACTIVE",
                        createdAt  = "",
                        redeemedAt = null,
                    )
            }

    // ─── Coupons ──────────────────────────────────────────────────────────────

    override suspend fun getCoupons(): WResult<List<Coupon>> =
        safeApiCall { api.getCoupons() }
            .mapSuccess { envelope ->
                @Suppress("UNCHECKED_CAST")
                val rows = (envelope["data"] ?: envelope["coupons"] ?: envelope["rows"]) as? List<*>
                    ?: envelope.values.filterIsInstance<List<*>>().firstOrNull()
                rows?.filterIsInstance<Map<*, *>>()?.map { it.toCoupon() } ?: emptyList()
            }

    override suspend fun createCoupon(params: Map<String, Any>): WResult<Coupon> =
        safeApiCall { api.createCoupon(params) }
            .mapSuccess { data -> (data as Map<*, *>).toCoupon() }

    override suspend fun updateCoupon(id: String, params: Map<String, Any>): WResult<Coupon> =
        safeApiCall { api.updateCoupon(id, params) }
            .mapSuccess { data -> (data as Map<*, *>).toCoupon() }

    override suspend fun deleteCoupon(id: String): WResult<Unit> =
        safeApiCall { api.deleteCoupon(id) }

    override suspend fun previewCoupon(code: String, amount: Double): WResult<CouponPreview> =
        safeApiCall {
            api.previewCoupon(mapOf("code" to code, "amount" to amount))
        }.mapSuccess { data ->
            val m = data as Map<*, *>
            CouponPreview(
                originalAmount = (m["originalAmount"] as? Number)?.toDouble() ?: amount,
                discountAmount = (m["discountAmount"] as? Number)?.toDouble() ?: 0.0,
                finalAmount    = (m["finalAmount"] as? Number)?.toDouble() ?: amount,
            )
        }

    // ─── Private mapping helpers ──────────────────────────────────────────────

    private fun PosSubmitRequest.toApiMap(): Map<String, Any> = buildMap {
        put("lineItems", lineItems.map { it.toApiMap() })
        put("paymentMethod", paymentMethod)
        put("discountTotal", discountTotal)
        put("finalAmount", finalAmount)
        put("notes", notes)
        if (patientId != null) put("patientId", patientId)
    }

    private fun PosLineItem.toApiMap(): Map<String, Any> = buildMap {
        put("lineType",     lineType)
        put("name",         name)
        put("qty",          qty)
        put("unitPrice",    unitPrice)
        put("lineDiscount", lineDiscount)
    }

    private fun Map<*, *>.toWalletTransaction(): WalletTransaction = WalletTransaction(
        id           = anyId(this["id"]),
        type         = this["type"] as? String ?: "CREDIT",
        amount       = (this["amount"] as? Number)?.toDouble() ?: 0.0,
        notes        = this["notes"] as? String,
        createdAt    = this["createdAt"] as? String ?: "",
        balanceAfter = (this["balanceAfter"] as? Number)?.toDouble() ?: 0.0,
    )

    private fun Map<*, *>.toGiftCard(): GiftCard = GiftCard(
        id         = anyId(this["id"]),
        code       = this["code"] as? String ?: "",
        amount     = (this["amount"] as? Number)?.toDouble() ?: 0.0,
        status     = this["status"] as? String ?: "ACTIVE",
        createdAt  = this["createdAt"] as? String ?: "",
        redeemedAt = this["redeemedAt"] as? String,
    )

    private fun Map<*, *>.toCoupon(): Coupon = Coupon(
        id              = anyId(this["id"]),
        code            = this["code"] as? String ?: "",
        discountType    = this["discountType"] as? String ?: "PERCENT",
        amount          = (this["amount"] as? Number)?.toDouble() ?: 0.0,
        minOrderAmount  = (this["minOrderAmount"] as? Number)?.toDouble(),
        maxRedemptions  = (this["maxRedemptions"] as? Number)?.toInt(),
        expiryDate      = this["expiryDate"] as? String,
        isActive        = this["isActive"] as? Boolean ?: true,
        redemptionCount = (this["redemptionCount"] as? Number)?.toInt() ?: 0,
    )
}

/** Coerces an id field that may be Int, Long, or String to a non-empty String. */
private fun anyId(raw: Any?): String = when (raw) {
    is Number -> raw.toLong().toString()
    is String -> raw
    else      -> ""
}

// ─── Private extension for mapSuccess ────────────────────────────────────────

private inline fun <T, R> WResult<T>.mapSuccess(transform: (T) -> R): WResult<R> =
    when (this) {
        is WResult.Success -> WResult.Success(transform(data))
        is WResult.Error   -> this
        WResult.Loading    -> WResult.Loading
    }

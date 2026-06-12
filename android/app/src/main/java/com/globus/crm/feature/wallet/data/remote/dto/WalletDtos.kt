package com.globus.crm.feature.wallet.data.remote.dto

import com.squareup.moshi.JsonClass

@JsonClass(generateAdapter = true)
data class WalletDto(
    val balance: Long,
    val currency: String,
    val transactions: List<WalletTransactionDto>,
)

@JsonClass(generateAdapter = true)
data class WalletTransactionDto(
    val id: Int,
    val type: String,
    val amount: Long,
    val description: String?,
    val date: String,
)

@JsonClass(generateAdapter = true)
data class GiftCardDto(
    val id: Int,
    val name: String,
    val amount: Long,
    val price: Long,
    val color: String?,
    val validityDays: Int,
    val currency: String,
    val expiresAt: String?,
)

@JsonClass(generateAdapter = true)
data class GiftCardStorefrontResponseDto(
    val giftCards: List<GiftCardDto>,
)

@JsonClass(generateAdapter = true)
data class GiftCardOrderDto(
    val patientId: Int?,
)

@JsonClass(generateAdapter = true)
data class GiftCardOrderResponseDto(
    val orderId: String,
    val paymentId: String,
    val key: String,
    val amount: Long,
    val currency: String,
    val giftCardId: Int,
    val patientId: Int,
    val patientName: String,
)

@JsonClass(generateAdapter = true)
data class GiftCardConfirmDto(
    val paymentId: String,
    val razorpay_order_id: String,
    val razorpay_payment_id: String,
    val razorpay_signature: String,
)

@JsonClass(generateAdapter = true)
data class GiftCardConfirmResponseDto(
    val giftCard: GiftCardDto,
    val transaction: WalletTransactionDto,
)

// GET /api/wellness/patients/{patientId}/wallet — CUSTOMER JWT (verifyToken).
// Dedicated wallet view: balance + wallet-only transactions.
// Real shape confirmed against staging 2026-06-04.
@JsonClass(generateAdapter = true)
data class PatientWalletResponseDto(
    val patient: WalletPatientRefDto,
    val wallet: WalletDetailDto,
    val transactions: List<WalletTxnDto>,
)

@JsonClass(generateAdapter = true)
data class WalletPatientRefDto(
    val id: Int,
    val name: String,
)

@JsonClass(generateAdapter = true)
data class WalletDetailDto(
    val id: Int,
    val tenantId: Int,
    val patientId: Int,
    val balance: Double,
    val currency: String,
    val createdAt: String? = null,
    val updatedAt: String? = null,
)

@JsonClass(generateAdapter = true)
data class WalletTxnDto(
    val id: Int,
    val tenantId: Int,
    val walletId: Int,
    val type: String,
    val amount: Double,
    val reason: String?,
    val visitId: Int?,
    val invoiceId: Int?,
    val giftCardId: Int?,
    val couponId: Int?,
    val balanceAfter: Double,
    val performedBy: Int?,
    val createdAt: String,
)

// GET /api/wellness/my-transactions — CUSTOMER JWT (verifyToken).
// Returns wallet balance + unified transaction timeline across all types.
@JsonClass(generateAdapter = true)
data class MyTransactionsResponseDto(
    val currency: String,
    val summary: TransactionSummaryDto,
    val transactions: List<TransactionDto>,
)

@JsonClass(generateAdapter = true)
data class TransactionSummaryDto(
    val totalPaid: Double,
    val posTotal: Double,
    val onlineTotal: Double,
    val subscriptionsTotal: Double,
    val walletBalance: Double,
    val walletTopUps: Double,
    val transactionCount: Int,
)

@JsonClass(generateAdapter = true)
data class TransactionDto(
    val id: String,
    val type: String,
    val category: String,
    val title: String,
    val description: String?,
    val amount: Double,
    val direction: String,
    val status: String,
    val reference: String?,
    val date: String,
    val paymentMethod: String?,
    val balanceAfter: Double?,
)

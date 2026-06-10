package com.globus.crm.feature.wallet.domain.model

data class WalletSummary(
    val balance: Double,
    val currency: String,
    val transactions: List<Transaction>,
)

data class Transaction(
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

data class GiftCard(
    val id: Int,
    val name: String,
    val amount: Long,
    val price: Long,
    val color: String?,
    val validityDays: Int,
    val currency: String,
    val expiresAt: String?,
)

data class GiftCardOrder(
    val orderId: String,
    val paymentId: String,
    val razorpayKey: String,
    val amount: Long,
    val currency: String,
    val giftCardId: Int,
    val patientId: Int,
    val patientName: String,
)

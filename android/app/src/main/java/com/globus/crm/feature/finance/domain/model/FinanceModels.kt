package com.globus.crm.feature.finance.domain.model

data class Payment(
    val id: Int,
    val amount: Long,
    val currency: String,
    val status: String,       // paid | pending | failed | refunded
    val gateway: String?,     // razorpay | stripe | null
    val description: String?,
    val createdAt: String,
)

data class PaymentConfig(
    val gateway: String,
    val razorpayKeyId: String?,
    val stripePublishableKey: String?,
)

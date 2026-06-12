package com.globus.crm.feature.finance.data.remote.dto

import com.squareup.moshi.JsonClass

@JsonClass(generateAdapter = true)
data class PaymentDto(
    val id: Int,
    val amount: Long?,
    val currency: String?,
    val status: String?,
    val gateway: String?,
    val description: String?,
    val createdAt: String?,
)

@JsonClass(generateAdapter = true)
data class PaymentConfigDto(
    val gateway: String?,
    val razorpayKeyId: String?,
    val stripePublishableKey: String?,
)

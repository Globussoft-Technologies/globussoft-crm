package com.globussoft.wellness.core.network.model.response

data class PaymentResponse(
    val id: String,
    val amount: Double?,
    val method: String?,
    val status: String?,
    val reference: String?,
    val contact: PaymentContactResponse?,
    val createdAt: String?,
)

data class PaymentContactResponse(
    val id: String,
    val contactName: String?,
    val name: String?,
)

data class PaymentsListResponse(
    val payments: List<PaymentResponse>?,
    val total: Int?,
)

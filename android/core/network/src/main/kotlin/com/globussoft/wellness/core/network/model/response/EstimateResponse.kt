package com.globussoft.wellness.core.network.model.response

data class EstimateResponse(
    val id: String,
    val estimateNumber: String?,
    val status: String?,
    val amount: Double?,
    val tax: Double?,
    val total: Double?,
    val validUntil: String?,
    val contact: EstimateContactResponse?,
    val lineItems: List<EstimateLineItemResponse>?,
    val createdAt: String?,
)

data class EstimateContactResponse(
    val id: String,
    val contactName: String?,
    val name: String?,
)

data class EstimateLineItemResponse(
    val id: String?,
    val description: String?,
    val quantity: Int,
    val unitPrice: Double,
    val total: Double?,
)

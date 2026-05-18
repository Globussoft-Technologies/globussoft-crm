package com.globussoft.wellness.core.network.model.request

data class CreateEstimateRequest(
    val contactId: String?,
    val validUntil: String?,
    val lineItems: List<EstimateLineItemRequest>,
    val notes: String?,
)

data class EstimateLineItemRequest(
    val description: String,
    val quantity: Int,
    val unitPrice: Double,
)

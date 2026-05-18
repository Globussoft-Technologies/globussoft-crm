package com.globussoft.wellness.core.domain.model

data class Estimate(
    val id: String,
    val estimateNumber: String,
    val status: String,
    val amount: Double,
    val tax: Double,
    val total: Double,
    val validUntil: String?,
    val contactName: String?,
    val contactEmail: String?,
    val lineItems: List<EstimateLineItem>,
    val createdAt: String?,
) {
    val isDraft: Boolean get() = status == "DRAFT"
    val isAccepted: Boolean get() = status == "ACCEPTED"
    val isRejected: Boolean get() = status == "REJECTED"
}

data class EstimateLineItem(
    val description: String,
    val quantity: Int,
    val unitPrice: Double,
    val total: Double,
)

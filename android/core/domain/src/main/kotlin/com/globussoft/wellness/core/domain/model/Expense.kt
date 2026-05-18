package com.globussoft.wellness.core.domain.model

data class Expense(
    val id: String,
    val description: String,
    val amount: Double,
    val category: String?,
    val status: String,
    val date: String?,
    val receiptUrl: String?,
    val userName: String?,
    val createdAt: String?,
) {
    val isPending: Boolean get() = status == "PENDING"
    val isApproved: Boolean get() = status == "APPROVED"
    val isRejected: Boolean get() = status == "REJECTED"
}

package com.globussoft.wellness.core.network.model.response

data class ExpenseResponse(
    val id: String,
    val description: String?,
    val amount: Double,
    val category: String?,
    val date: String?,
    val status: String?,
    val receiptUrl: String?,
    val user: ExpenseUserResponse?,
    val createdAt: String?,
)

data class ExpenseUserResponse(
    val id: String,
    val name: String?,
)

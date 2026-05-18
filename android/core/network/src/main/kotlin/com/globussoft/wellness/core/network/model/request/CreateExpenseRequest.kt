package com.globussoft.wellness.core.network.model.request

data class CreateExpenseRequest(
    val title: String,
    val amount: Double,
    val category: String,
    val date: String,
    val notes: String? = null,
)

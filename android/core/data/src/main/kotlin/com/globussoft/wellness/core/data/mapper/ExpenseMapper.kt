package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Expense
import com.globussoft.wellness.core.network.model.response.ExpenseResponse

fun ExpenseResponse.toDomain(): Expense = Expense(
    id = id,
    description = description ?: "",
    amount = amount,
    category = category,
    status = status ?: "",
    date = date,
    receiptUrl = receiptUrl,
    userName = user?.name,
    createdAt = createdAt,
)

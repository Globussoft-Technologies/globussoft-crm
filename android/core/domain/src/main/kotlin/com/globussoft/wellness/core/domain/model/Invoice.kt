package com.globussoft.wellness.core.domain.model

data class Invoice(
    val id: String,
    val invoiceNumber: String,
    val status: String,
    val amount: Double,
    val tax: Double,
    val total: Double,
    val dueDate: String?,
    val paidAt: String?,
    val contactName: String?,
    val contactEmail: String?,
    val lineItems: List<InvoiceLineItem>,
    val createdAt: String?,
) {
    val isOverdue: Boolean get() = status == "OVERDUE"
    val isPaid: Boolean get() = status == "PAID"
}

data class InvoiceLineItem(
    val description: String,
    val quantity: Int,
    val unitPrice: Double,
    val total: Double,
)

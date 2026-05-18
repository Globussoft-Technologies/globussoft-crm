package com.globussoft.wellness.core.network.model.response

data class InvoiceResponse(
    val id: String,
    val invoiceNumber: String?,
    val status: String?,
    val amount: Double?,
    val tax: Double?,
    val total: Double?,
    val dueDate: String?,
    val paidAt: String?,
    val contact: InvoiceContactResponse?,
    val lineItems: List<InvoiceLineItemResponse>?,
    val createdAt: String?,
    val updatedAt: String?,
)

data class InvoiceContactResponse(
    val id: String,
    val contactName: String?,
    val name: String?,
    val email: String?,
)

data class InvoiceLineItemResponse(
    val id: String?,
    val description: String?,
    val quantity: Int,
    val unitPrice: Double,
    val total: Double?,
)

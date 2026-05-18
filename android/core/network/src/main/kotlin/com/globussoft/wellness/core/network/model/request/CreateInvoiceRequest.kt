package com.globussoft.wellness.core.network.model.request

data class CreateInvoiceRequest(
    val contactId: String?,
    val dueDate: String?,
    val lineItems: List<InvoiceLineItemRequest>,
    val notes: String?,
)

data class InvoiceLineItemRequest(
    val description: String,
    val quantity: Int,
    val unitPrice: Double,
)

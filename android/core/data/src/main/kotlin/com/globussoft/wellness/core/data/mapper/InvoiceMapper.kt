package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Invoice
import com.globussoft.wellness.core.domain.model.InvoiceLineItem
import com.globussoft.wellness.core.network.model.response.InvoiceLineItemResponse
import com.globussoft.wellness.core.network.model.response.InvoiceResponse

fun InvoiceResponse.toDomain(): Invoice = Invoice(
    id = id,
    invoiceNumber = invoiceNumber ?: id,
    status = status ?: "",
    amount = amount ?: 0.0,
    tax = tax ?: 0.0,
    total = total ?: 0.0,
    dueDate = dueDate,
    paidAt = paidAt,
    contactName = contact?.name ?: contact?.contactName,
    contactEmail = contact?.email,
    lineItems = lineItems?.map { it.toDomain() } ?: emptyList(),
    createdAt = createdAt,
)

fun InvoiceLineItemResponse.toDomain(): InvoiceLineItem = InvoiceLineItem(
    description = description ?: "",
    quantity = quantity,
    unitPrice = unitPrice,
    total = total ?: (quantity * unitPrice),
)

package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Estimate
import com.globussoft.wellness.core.domain.model.EstimateLineItem
import com.globussoft.wellness.core.network.model.response.EstimateLineItemResponse
import com.globussoft.wellness.core.network.model.response.EstimateResponse

fun EstimateResponse.toDomain(): Estimate = Estimate(
    id = id,
    estimateNumber = estimateNumber ?: id,
    status = status ?: "DRAFT",
    amount = amount ?: 0.0,
    tax = tax ?: 0.0,
    total = total ?: 0.0,
    validUntil = validUntil,
    contactName = contact?.name ?: contact?.contactName,
    contactEmail = null,
    lineItems = lineItems?.map { it.toDomain() } ?: emptyList(),
    createdAt = createdAt,
)

fun EstimateLineItemResponse.toDomain(): EstimateLineItem = EstimateLineItem(
    description = description ?: "",
    quantity = quantity,
    unitPrice = unitPrice,
    total = total ?: (quantity * unitPrice),
)

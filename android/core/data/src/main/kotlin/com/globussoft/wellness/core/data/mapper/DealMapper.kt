package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.Deal
import com.globussoft.wellness.core.domain.model.DealStats
import com.globussoft.wellness.core.network.model.response.DealResponse
import com.globussoft.wellness.core.network.model.response.DealStatsResponse

fun DealResponse.toDomain(): Deal = Deal(
    id = id,
    title = title ?: "",
    amount = amount ?: 0.0,
    stage = stage ?: "Unknown",
    status = status ?: "OPEN",
    probability = probability ?: 0,
    expectedClose = expectedClose,
    pipelineName = pipeline?.name ?: pipeline?.id,
    contactName = contact?.name ?: contact?.contactName,
    ownerName = owner?.name,
    createdAt = createdAt,
)

fun DealStatsResponse.toDomain(): DealStats = DealStats(
    totalDeals = totalDeals,
    totalValue = totalValue,
    wonCount = wonCount,
    wonValue = wonValue,
    lostCount = lostCount,
    lostValue = lostValue,
    expectedValue = expectedValue,
    conversionRate = conversionRate,
    openCount = openCount ?: (totalDeals - wonCount - lostCount),
)

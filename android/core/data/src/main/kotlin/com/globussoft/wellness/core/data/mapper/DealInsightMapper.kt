package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.DealInsight
import com.globussoft.wellness.core.network.model.response.DealInsightResponse

fun DealInsightResponse.toDomain(): DealInsight = DealInsight(
    id = id,
    dealId = dealId,
    dealTitle = dealTitle,
    closabilityScore = closabilityScore,
    riskLevel = riskLevel,
    insights = insights,
    suggestedAction = suggestedAction,
    generatedAt = generatedAt,
)

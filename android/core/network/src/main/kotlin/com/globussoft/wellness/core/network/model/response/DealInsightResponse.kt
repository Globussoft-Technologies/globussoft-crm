package com.globussoft.wellness.core.network.model.response

data class DealInsightResponse(
    val id: String,
    val dealId: String,
    val dealTitle: String?,
    val closabilityScore: Int?,
    val riskLevel: String?,
    val insights: String?,
    val suggestedAction: String?,
    val generatedAt: String?,
)

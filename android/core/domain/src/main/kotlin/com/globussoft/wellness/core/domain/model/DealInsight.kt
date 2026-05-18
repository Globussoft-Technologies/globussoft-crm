package com.globussoft.wellness.core.domain.model

data class DealInsight(
    val id: String,
    val dealId: String,
    val dealTitle: String?,
    val closabilityScore: Int?,
    val riskLevel: String?,
    val insights: String?,
    val suggestedAction: String?,
    val generatedAt: String?,
) {
    val isHighRisk: Boolean get() = riskLevel == "HIGH"
    val isMediumRisk: Boolean get() = riskLevel == "MEDIUM"
}

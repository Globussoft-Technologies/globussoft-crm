package com.globussoft.wellness.feature.crm.presentation.dealinsights

import com.globussoft.wellness.core.domain.model.DealInsight

data class DealInsightsUiState(
    val isLoading: Boolean = false,
    val insights: List<DealInsight> = emptyList(),
    val error: String? = null,
    val selectedRisk: String? = null,
)

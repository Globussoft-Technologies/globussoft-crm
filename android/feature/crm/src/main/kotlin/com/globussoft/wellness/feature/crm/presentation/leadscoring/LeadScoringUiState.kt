package com.globussoft.wellness.feature.crm.presentation.leadscoring

data class LeadScoringUiState(
    val isLoading: Boolean = false,
    val leads: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
)

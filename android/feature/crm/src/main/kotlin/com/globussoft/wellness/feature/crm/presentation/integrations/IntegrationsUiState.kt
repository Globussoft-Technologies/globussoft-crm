package com.globussoft.wellness.feature.crm.presentation.integrations

data class IntegrationsUiState(
    val isLoading: Boolean = false,
    val integrations: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
)

package com.globussoft.wellness.feature.crm.presentation.customreports

data class CustomReportsUiState(
    val isLoading: Boolean = false,
    val reports: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

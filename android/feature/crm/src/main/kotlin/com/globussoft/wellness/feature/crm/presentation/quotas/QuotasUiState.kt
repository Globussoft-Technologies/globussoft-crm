package com.globussoft.wellness.feature.crm.presentation.quotas

data class QuotasUiState(
    val isLoading: Boolean = false,
    val quotas: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

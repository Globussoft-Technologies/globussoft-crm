package com.globussoft.wellness.feature.crm.presentation.sla

data class SlaUiState(
    val isLoading: Boolean = false,
    val policies: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

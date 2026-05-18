package com.globussoft.wellness.feature.crm.presentation.leadrouting

data class LeadRoutingUiState(
    val isLoading: Boolean = false,
    val rules: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

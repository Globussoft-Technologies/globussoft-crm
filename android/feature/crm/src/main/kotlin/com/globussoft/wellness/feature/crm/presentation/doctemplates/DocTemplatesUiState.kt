package com.globussoft.wellness.feature.crm.presentation.doctemplates

data class DocTemplatesUiState(
    val isLoading: Boolean = false,
    val templates: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

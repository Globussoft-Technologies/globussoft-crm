package com.globussoft.wellness.feature.crm.presentation.abtests

data class AbTestsUiState(
    val isLoading: Boolean = false,
    val tests: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

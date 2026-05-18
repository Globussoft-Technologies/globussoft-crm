package com.globussoft.wellness.feature.crm.presentation.playbooks

data class PlaybooksUiState(
    val isLoading: Boolean = false,
    val playbooks: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

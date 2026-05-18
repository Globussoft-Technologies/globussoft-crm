package com.globussoft.wellness.feature.crm.presentation.signatures

data class SignaturesUiState(
    val isLoading: Boolean = false,
    val signatures: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

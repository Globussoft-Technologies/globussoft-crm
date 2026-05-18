package com.globussoft.wellness.feature.crm.presentation.landingpages

data class LandingPagesUiState(
    val isLoading: Boolean = false,
    val pages: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

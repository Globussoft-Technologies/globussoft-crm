package com.globussoft.wellness.feature.crm.presentation.portal

data class PortalUiState(
    val isLoading: Boolean = false,
    val bookingPages: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

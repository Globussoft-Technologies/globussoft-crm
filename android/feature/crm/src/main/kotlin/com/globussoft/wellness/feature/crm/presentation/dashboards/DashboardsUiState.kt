package com.globussoft.wellness.feature.crm.presentation.dashboards

data class DashboardsUiState(
    val isLoading: Boolean = false,
    val dashboards: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

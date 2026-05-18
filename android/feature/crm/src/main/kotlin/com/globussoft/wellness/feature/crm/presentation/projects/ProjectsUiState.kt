package com.globussoft.wellness.feature.crm.presentation.projects

data class ProjectsUiState(
    val isLoading: Boolean = false,
    val projects: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val selectedStatus: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

package com.globussoft.wellness.feature.crm.presentation.territories

data class TerritoriesUiState(
    val isLoading: Boolean = false,
    val territories: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

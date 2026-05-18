package com.globussoft.wellness.feature.crm.presentation.surveys

data class SurveysUiState(
    val isLoading: Boolean = false,
    val surveys: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

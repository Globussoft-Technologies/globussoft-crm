package com.globussoft.wellness.feature.crm.presentation.staff

data class StaffUiState(
    val isLoading: Boolean = false,
    val staff: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val search: String = "",
    val showForm: Boolean = false,
    val editingId: String? = null,
    val isSubmitting: Boolean = false,
    val formError: String? = null,
)

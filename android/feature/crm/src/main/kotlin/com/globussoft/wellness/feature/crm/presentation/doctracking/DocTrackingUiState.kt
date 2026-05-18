package com.globussoft.wellness.feature.crm.presentation.doctracking

data class DocTrackingUiState(
    val isLoading: Boolean = false,
    val views: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
)

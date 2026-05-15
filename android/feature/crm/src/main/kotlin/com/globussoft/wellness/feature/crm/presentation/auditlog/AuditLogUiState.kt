package com.globussoft.wellness.feature.crm.presentation.auditlog

data class AuditLogUiState(
    val isLoading: Boolean = false,
    val logs: List<Map<String, Any>> = emptyList(),
    val totalPages: Int = 1,
    val currentPage: Int = 1,
    val error: String? = null,
    val selectedEntityType: String? = null,
    val selectedAction: String? = null,
)

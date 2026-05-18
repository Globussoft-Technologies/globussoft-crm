package com.globussoft.wellness.feature.crm.presentation.sharedinbox

data class SharedInboxUiState(
    val isLoading: Boolean = false,
    val conversations: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val selectedStatus: String? = null,
    val assigningId: String? = null,
)

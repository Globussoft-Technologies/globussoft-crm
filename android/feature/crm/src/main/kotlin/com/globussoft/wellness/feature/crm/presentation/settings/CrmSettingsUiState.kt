package com.globussoft.wellness.feature.crm.presentation.settings

data class CrmSettingsUiState(
    val isLoading: Boolean = false,
    val settings: Map<String, Any> = emptyMap(),
    val error: String? = null,
    val isSaving: Boolean = false,
    val saveError: String? = null,
)

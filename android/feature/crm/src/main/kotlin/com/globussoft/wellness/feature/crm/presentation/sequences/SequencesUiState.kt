package com.globussoft.wellness.feature.crm.presentation.sequences

data class SequencesUiState(
    val isLoading: Boolean = false,
    val sequences: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val togglingId: String? = null,   // id of sequence being toggled
)

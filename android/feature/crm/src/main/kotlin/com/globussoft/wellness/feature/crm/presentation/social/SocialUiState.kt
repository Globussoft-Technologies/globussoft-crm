package com.globussoft.wellness.feature.crm.presentation.social

data class SocialUiState(
    val isLoading: Boolean = false,
    val mentions: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
)

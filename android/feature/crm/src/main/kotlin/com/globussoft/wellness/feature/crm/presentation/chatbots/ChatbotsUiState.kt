package com.globussoft.wellness.feature.crm.presentation.chatbots

data class ChatbotsUiState(
    val isLoading: Boolean = false,
    val chatbots: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
)

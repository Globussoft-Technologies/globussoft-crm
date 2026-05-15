package com.globussoft.wellness.feature.crm.presentation.channels

data class ChannelsUiState(
    val isLoading: Boolean = false,
    val channels: Map<String, Any> = emptyMap(),
    val error: String? = null,
    val selectedTab: Int = 0,
)

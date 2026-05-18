package com.globussoft.wellness.feature.crm.presentation.marketplaceleads

data class MarketplaceLeadsUiState(
    val isLoading: Boolean = false,
    val leads: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
)

package com.globussoft.wellness.feature.crm.presentation.marketing

import com.globussoft.wellness.core.domain.model.Campaign

data class MarketingUiState(
    val isLoading: Boolean = false,
    val campaigns: List<Campaign> = emptyList(),
    val error: String? = null,
    val selectedChannel: String? = null,
    val selectedTab: Int = 0,
)

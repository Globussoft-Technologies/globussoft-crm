package com.globussoft.wellness.feature.crm.presentation.marketing

import com.globussoft.wellness.core.domain.model.Campaign

data class MarketingUiState(
    val isLoading: Boolean = false,
    val campaigns: List<Campaign> = emptyList(),
    val error: String? = null,
    val selectedChannel: String? = null,
    val selectedTab: Int = 0,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
    val selectedStatus: String? = null,   // null = All
)

package com.globussoft.wellness.feature.crm.presentation.dashboard

import com.globussoft.wellness.core.domain.model.Deal
import com.globussoft.wellness.core.domain.model.DealStats

data class CrmDashboardUiState(
    val isLoading: Boolean = false,
    val stats: DealStats? = null,
    val recentDeals: List<Deal> = emptyList(),
    val error: String? = null,
)

package com.globussoft.wellness.feature.crm.presentation.approvals

import com.globussoft.wellness.core.domain.model.Approval

data class ApprovalsUiState(
    val isLoading: Boolean = false,
    val approvals: List<Approval> = emptyList(),
    val error: String? = null,
    val selectedTab: Int = 0,  // 0=My Requests, 1=To Approve, 2=All
)

package com.globus.crm.feature.auth.presentation.state

import com.globus.crm.feature.auth.domain.model.TenantBranding

data class SplashUiState(
    val isLoading: Boolean = true,
    val tenantBranding: TenantBranding? = null,
    val error: String? = null,
)

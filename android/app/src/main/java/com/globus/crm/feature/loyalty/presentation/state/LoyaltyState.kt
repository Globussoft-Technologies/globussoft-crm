package com.globus.crm.feature.loyalty.presentation.state

import com.globus.crm.feature.loyalty.domain.model.LoyaltyData

data class LoyaltyUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val loyaltyData: LoyaltyData? = null,
)

sealed class LoyaltyUiEvent {
    object Refresh : LoyaltyUiEvent()
    object NavigateBack : LoyaltyUiEvent()
}

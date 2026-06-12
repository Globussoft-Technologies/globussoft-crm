package com.globus.crm.feature.dashboard.presentation.state

import com.globus.crm.feature.dashboard.domain.model.Dashboard

data class DashboardUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val dashboard: Dashboard? = null,
)

sealed class DashboardUiEvent {
    object Refresh : DashboardUiEvent()
    object NavigateToAppointments : DashboardUiEvent()
    object NavigateToBooking : DashboardUiEvent()
    object NavigateToPrescriptions : DashboardUiEvent()
    object NavigateToProfile : DashboardUiEvent()
    object NavigateToWallet : DashboardUiEvent()
    object NavigateToMemberships : DashboardUiEvent()
    object NavigateToNotifications : DashboardUiEvent()
    object NavigateToGiftCards : DashboardUiEvent()
    object NavigateToLoyalty : DashboardUiEvent()
    object NavigateToVisitHistory : DashboardUiEvent()
    object NavigateToTreatmentPlans : DashboardUiEvent()
    object NavigateToConsentForms : DashboardUiEvent()
    object NavigateToWaitlist : DashboardUiEvent()
    object Logout : DashboardUiEvent()
}

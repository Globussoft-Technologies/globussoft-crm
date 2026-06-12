package com.globus.crm.feature.dashboard.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.usecase.LogoutUseCase
import com.globus.crm.feature.dashboard.domain.usecase.GetDashboardUseCase
import com.globus.crm.feature.dashboard.presentation.state.DashboardUiEvent
import com.globus.crm.feature.dashboard.presentation.state.DashboardUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class DashboardNavEvent {
    object ToAppointments : DashboardNavEvent()
    object ToBooking : DashboardNavEvent()
    object ToPrescriptions : DashboardNavEvent()
    object ToProfile : DashboardNavEvent()
    object ToWallet : DashboardNavEvent()
    object ToMemberships : DashboardNavEvent()
    object ToNotifications : DashboardNavEvent()
    object ToGiftCards : DashboardNavEvent()
    object ToLoyalty : DashboardNavEvent()
    object ToVisitHistory : DashboardNavEvent()
    object ToTreatmentPlans : DashboardNavEvent()
    object ToConsentForms : DashboardNavEvent()
    object ToWaitlist : DashboardNavEvent()
    object ToLogin : DashboardNavEvent()
}

@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val getDashboardUseCase: GetDashboardUseCase,
    private val logoutUseCase: LogoutUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(DashboardUiState())
    val uiState: StateFlow<DashboardUiState> = _uiState.asStateFlow()

    private val _navigationEvent = Channel<DashboardNavEvent>(Channel.BUFFERED)
    val navigationEvent = _navigationEvent.receiveAsFlow()

    init {
        loadDashboard()
    }

    fun onEvent(event: DashboardUiEvent) {
        when (event) {
            DashboardUiEvent.Refresh -> loadDashboard()
            DashboardUiEvent.NavigateToAppointments -> emit(DashboardNavEvent.ToAppointments)
            DashboardUiEvent.NavigateToBooking -> emit(DashboardNavEvent.ToBooking)
            DashboardUiEvent.NavigateToPrescriptions -> emit(DashboardNavEvent.ToPrescriptions)
            DashboardUiEvent.NavigateToProfile -> emit(DashboardNavEvent.ToProfile)
            DashboardUiEvent.NavigateToWallet -> emit(DashboardNavEvent.ToWallet)
            DashboardUiEvent.NavigateToMemberships -> emit(DashboardNavEvent.ToMemberships)
            DashboardUiEvent.NavigateToNotifications -> emit(DashboardNavEvent.ToNotifications)
            DashboardUiEvent.NavigateToGiftCards -> emit(DashboardNavEvent.ToGiftCards)
            DashboardUiEvent.NavigateToLoyalty -> emit(DashboardNavEvent.ToLoyalty)
            DashboardUiEvent.NavigateToVisitHistory -> emit(DashboardNavEvent.ToVisitHistory)
            DashboardUiEvent.NavigateToTreatmentPlans -> emit(DashboardNavEvent.ToTreatmentPlans)
            DashboardUiEvent.NavigateToConsentForms -> emit(DashboardNavEvent.ToConsentForms)
            DashboardUiEvent.NavigateToWaitlist -> emit(DashboardNavEvent.ToWaitlist)
            DashboardUiEvent.Logout -> logout()
        }
    }

    private fun loadDashboard() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            when (val result = getDashboardUseCase()) {
                is Result.Success -> _uiState.value = DashboardUiState(
                    isLoading = false,
                    dashboard = result.data,
                )
                is Result.Error -> _uiState.value = DashboardUiState(
                    isLoading = false,
                    error = result.message,
                )
                Result.Loading -> Unit
            }
        }
    }

    private fun logout() {
        viewModelScope.launch {
            logoutUseCase()
            _navigationEvent.send(DashboardNavEvent.ToLogin)
        }
    }

    private fun emit(event: DashboardNavEvent) {
        viewModelScope.launch { _navigationEvent.send(event) }
    }
}

package com.globus.crm.feature.booking.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.booking.domain.usecase.CancelAppointmentUseCase
import com.globus.crm.feature.booking.domain.usecase.GetMyAppointmentsUseCase
import com.globus.crm.feature.booking.domain.usecase.RescheduleAppointmentUseCase
import com.globus.crm.feature.booking.presentation.state.MyAppointmentsUiEvent
import com.globus.crm.feature.booking.presentation.state.MyAppointmentsUiState
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class MyAppointmentsNavEvent {
    object ToBook : MyAppointmentsNavEvent()
    object ToHistory : MyAppointmentsNavEvent()
    object Back : MyAppointmentsNavEvent()
}

@HiltViewModel
class MyAppointmentsViewModel @Inject constructor(
    private val getMyAppointments: GetMyAppointmentsUseCase,
    private val cancelAppointment: CancelAppointmentUseCase,
    private val rescheduleAppointment: RescheduleAppointmentUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(MyAppointmentsUiState())
    val uiState: StateFlow<MyAppointmentsUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<MyAppointmentsNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        load()
    }

    fun onEvent(event: MyAppointmentsUiEvent) {
        when (event) {
            MyAppointmentsUiEvent.Refresh -> load()
            is MyAppointmentsUiEvent.ShowActionSheet ->
                _uiState.value = _uiState.value.copy(actionSheetAppointment = event.appointment)
            MyAppointmentsUiEvent.DismissActionSheet ->
                _uiState.value = _uiState.value.copy(actionSheetAppointment = null)
            is MyAppointmentsUiEvent.RequestCancel ->
                _uiState.value = _uiState.value.copy(
                    actionSheetAppointment = null,
                    showCancelConfirmDialog = true,
                    appointmentToCancel = event.appointment,
                )
            MyAppointmentsUiEvent.ConfirmCancel -> {
                val id = _uiState.value.appointmentToCancel?.id ?: return
                _uiState.value = _uiState.value.copy(showCancelConfirmDialog = false, appointmentToCancel = null)
                cancel(id)
            }
            MyAppointmentsUiEvent.DismissCancel ->
                _uiState.value = _uiState.value.copy(showCancelConfirmDialog = false, appointmentToCancel = null)
            is MyAppointmentsUiEvent.Cancel -> cancel(event.appointmentId)
            is MyAppointmentsUiEvent.ShowRescheduleSheet ->
                _uiState.value = _uiState.value.copy(
                    actionSheetAppointment = null,
                    rescheduleSheetAppointmentId = event.appointmentId,
                    rescheduleError = null,
                )
            MyAppointmentsUiEvent.DismissRescheduleSheet ->
                _uiState.value = _uiState.value.copy(rescheduleSheetAppointmentId = null, rescheduleError = null)
            is MyAppointmentsUiEvent.ConfirmReschedule -> reschedule(event.newDate, event.newTime)
            MyAppointmentsUiEvent.NavigateToBook -> emit(MyAppointmentsNavEvent.ToBook)
            MyAppointmentsUiEvent.NavigateToHistory -> emit(MyAppointmentsNavEvent.ToHistory)
            MyAppointmentsUiEvent.NavigateBack -> emit(MyAppointmentsNavEvent.Back)
        }
    }

    private fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            coroutineScope {
                val upcomingDeferred = async { getMyAppointments("upcoming") }
                val pastDeferred = async { getMyAppointments("completed") }
                val pendingDeferred = async { getMyAppointments("pending") }
                val cancelledDeferred = async { getMyAppointments("cancelled") }
                val upcoming = upcomingDeferred.await()
                val past = pastDeferred.await()
                val pending = pendingDeferred.await()
                val cancelled = cancelledDeferred.await()
                _uiState.value = MyAppointmentsUiState(
                    isLoading = false,
                    upcoming = if (upcoming is Result.Success) upcoming.data else emptyList(),
                    past = if (past is Result.Success) past.data else emptyList(),
                    pending = if (pending is Result.Success) pending.data else emptyList(),
                    cancelled = if (cancelled is Result.Success) cancelled.data else emptyList(),
                    error = if (upcoming is Result.Error) upcoming.message else null,
                )
            }
        }
    }

    private fun cancel(appointmentId: Int) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(cancellingId = appointmentId)
            when (cancelAppointment(appointmentId)) {
                is Result.Success -> load()
                is Result.Error -> _uiState.value = _uiState.value.copy(
                    cancellingId = null,
                    error = "Failed to cancel appointment",
                )
                Result.Loading -> Unit
            }
        }
    }

    private fun reschedule(newDate: String, newTime: String) {
        val appointmentId = _uiState.value.rescheduleSheetAppointmentId ?: return
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isRescheduling = true, rescheduleError = null)
            when (val result = rescheduleAppointment(appointmentId, newDate, newTime)) {
                is Result.Success -> {
                    _uiState.value = _uiState.value.copy(
                        isRescheduling = false,
                        rescheduleSheetAppointmentId = null,
                    )
                    load()
                }
                is Result.Error -> _uiState.value = _uiState.value.copy(
                    isRescheduling = false,
                    rescheduleError = result.message,
                )
                Result.Loading -> Unit
            }
        }
    }

    private fun emit(event: MyAppointmentsNavEvent) {
        viewModelScope.launch { _navEvent.send(event) }
    }
}

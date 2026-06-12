package com.globus.crm.feature.booking.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.storage.EncryptedPrefsManager
import com.globus.crm.core.util.Result
import com.globus.crm.feature.booking.domain.repository.AppointmentRepository
import com.globus.crm.feature.booking.domain.usecase.GetPortalProductsUseCase
import com.globus.crm.feature.booking.presentation.state.WaitlistUiEvent
import com.globus.crm.feature.booking.presentation.state.WaitlistUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class WaitlistNavEvent {
    object Back : WaitlistNavEvent()
}

@HiltViewModel
class WaitlistViewModel @Inject constructor(
    private val repository: AppointmentRepository,
    private val getPortalProducts: GetPortalProductsUseCase,
    private val encryptedPrefsManager: EncryptedPrefsManager,
) : ViewModel() {

    private val _uiState = MutableStateFlow(WaitlistUiState())
    val uiState: StateFlow<WaitlistUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<WaitlistNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        load()
    }

    fun onEvent(event: WaitlistUiEvent) {
        when (event) {
            WaitlistUiEvent.Load -> load()
            WaitlistUiEvent.ShowAddSheet ->
                _uiState.value = _uiState.value.copy(
                    showAddSheet = true,
                    selectedServiceId = null,
                    formNotes = "",
                    formError = null,
                )
            WaitlistUiEvent.DismissAddSheet ->
                _uiState.value = _uiState.value.copy(
                    showAddSheet = false,
                    formError = null,
                )
            is WaitlistUiEvent.SelectService ->
                _uiState.value = _uiState.value.copy(selectedServiceId = event.serviceId)
            is WaitlistUiEvent.UpdateNotes ->
                _uiState.value = _uiState.value.copy(formNotes = event.notes)
            WaitlistUiEvent.SubmitWaitlist -> submitWaitlist()
            is WaitlistUiEvent.CancelEntry -> Unit // No cancel endpoint defined; no-op for now
        }
    }

    private fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            coroutineScope {
                val waitlistDeferred = async {
                    try {
                        Result.Success(repository.getWaitlist())
                    } catch (e: Exception) {
                        Result.Error("LOAD_ERROR", e.message ?: "Failed to load waitlist")
                    }
                }
                val servicesDeferred = async { getPortalProducts() }

                val waitlistResult = waitlistDeferred.await()
                val servicesResult = servicesDeferred.await()

                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    entries = if (waitlistResult is Result.Success) waitlistResult.data else emptyList(),
                    services = if (servicesResult is Result.Success) servicesResult.data else emptyList(),
                    error = if (waitlistResult is Result.Error) waitlistResult.message else null,
                )
            }
        }
    }

    private fun submitWaitlist() {
        val serviceId = _uiState.value.selectedServiceId
        if (serviceId == null) {
            _uiState.value = _uiState.value.copy(formError = "Please select a service")
            return
        }
        val patientId = encryptedPrefsManager.getPatientId()
        if (patientId == null) {
            _uiState.value = _uiState.value.copy(formError = "Session expired. Please log in again.")
            return
        }
        val notes = _uiState.value.formNotes.trim().ifEmpty { null }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSubmitting = true, formError = null)
            try {
                repository.addToWaitlist(serviceId, patientId, notes)
                _uiState.value = _uiState.value.copy(
                    isSubmitting = false,
                    showAddSheet = false,
                    selectedServiceId = null,
                    formNotes = "",
                )
                load()
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(
                    isSubmitting = false,
                    formError = e.message ?: "Failed to join waitlist",
                )
            }
        }
    }

    private fun emit(event: WaitlistNavEvent) {
        viewModelScope.launch { _navEvent.send(event) }
    }
}

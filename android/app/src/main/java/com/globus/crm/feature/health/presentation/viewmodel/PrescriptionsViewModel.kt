package com.globus.crm.feature.health.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.model.PatientPermissions
import com.globus.crm.feature.auth.domain.usecase.GetPatientPermissionsUseCase
import com.globus.crm.feature.health.domain.usecase.GetPrescriptionsUseCase
import com.globus.crm.feature.health.presentation.state.PrescriptionsUiEvent
import com.globus.crm.feature.health.presentation.state.PrescriptionsUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class PrescriptionsNavEvent {
    data class ToPdf(val prescriptionId: Int) : PrescriptionsNavEvent()
    object Back : PrescriptionsNavEvent()
}

@HiltViewModel
class PrescriptionsViewModel @Inject constructor(
    private val getPrescriptions: GetPrescriptionsUseCase,
    private val getPermissions: GetPatientPermissionsUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(PrescriptionsUiState())
    val uiState: StateFlow<PrescriptionsUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<PrescriptionsNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        load()
    }

    fun onEvent(event: PrescriptionsUiEvent) {
        when (event) {
            PrescriptionsUiEvent.Refresh -> load()
            is PrescriptionsUiEvent.RequestViewPdf ->
                _uiState.value = _uiState.value.copy(showPdfConfirm = true, prescriptionToOpen = event.prescriptionId)
            PrescriptionsUiEvent.ConfirmViewPdf -> {
                val id = _uiState.value.prescriptionToOpen ?: return
                _uiState.value = _uiState.value.copy(showPdfConfirm = false, prescriptionToOpen = null)
                viewModelScope.launch { _navEvent.send(PrescriptionsNavEvent.ToPdf(id)) }
            }
            PrescriptionsUiEvent.DismissPdfConfirm ->
                _uiState.value = _uiState.value.copy(showPdfConfirm = false, prescriptionToOpen = null)
            is PrescriptionsUiEvent.ViewPdf -> viewModelScope.launch { _navEvent.send(PrescriptionsNavEvent.ToPdf(event.prescriptionId)) }
            PrescriptionsUiEvent.NavigateBack -> viewModelScope.launch { _navEvent.send(PrescriptionsNavEvent.Back) }
        }
    }

    private fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null, permissionBlocked = false)
            val permResult = getPermissions()
            if (permResult is Result.Success && !permResult.data.has(PatientPermissions.PRESCRIPTIONS_READ)) {
                _uiState.value = PrescriptionsUiState(isLoading = false, permissionBlocked = true)
                return@launch
            }
            when (val result = getPrescriptions()) {
                is Result.Success -> _uiState.value = PrescriptionsUiState(isLoading = false, prescriptions = result.data)
                is Result.Error -> _uiState.value = PrescriptionsUiState(isLoading = false, error = result.message)
                Result.Loading -> Unit
            }
        }
    }
}

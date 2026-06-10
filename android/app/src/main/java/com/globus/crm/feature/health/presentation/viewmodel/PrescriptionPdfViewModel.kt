package com.globus.crm.feature.health.presentation.viewmodel

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.health.domain.usecase.GetPrescriptionPdfUseCase
import com.globus.crm.feature.health.presentation.state.PrescriptionPdfUiEvent
import com.globus.crm.feature.health.presentation.state.PrescriptionPdfUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class PrescriptionPdfNavEvent {
    object Back : PrescriptionPdfNavEvent()
}

@HiltViewModel
class PrescriptionPdfViewModel @Inject constructor(
    private val getPrescriptionPdf: GetPrescriptionPdfUseCase,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val prescriptionId: Int = checkNotNull(savedStateHandle["id"]).toString().toInt()

    private val _uiState = MutableStateFlow(PrescriptionPdfUiState())
    val uiState: StateFlow<PrescriptionPdfUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<PrescriptionPdfNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        loadPdf()
    }

    fun onEvent(event: PrescriptionPdfUiEvent) {
        when (event) {
            PrescriptionPdfUiEvent.NavigateBack -> viewModelScope.launch { _navEvent.send(PrescriptionPdfNavEvent.Back) }
        }
    }

    private fun loadPdf() {
        viewModelScope.launch {
            _uiState.value = PrescriptionPdfUiState(isLoading = true)
            when (val result = getPrescriptionPdf(prescriptionId)) {
                is Result.Success -> _uiState.value = PrescriptionPdfUiState(isLoading = false, pdfBytes = result.data)
                is Result.Error -> _uiState.value = PrescriptionPdfUiState(isLoading = false, error = result.message)
                Result.Loading -> Unit
            }
        }
    }
}

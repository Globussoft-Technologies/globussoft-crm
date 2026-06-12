package com.globus.crm.feature.health.presentation.viewmodel

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.health.domain.usecase.GetConsentFormPdfUseCase
import com.globus.crm.feature.health.presentation.state.ConsentFormPdfUiEvent
import com.globus.crm.feature.health.presentation.state.ConsentFormPdfUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class ConsentFormPdfNavEvent {
    object Back : ConsentFormPdfNavEvent()
}

@HiltViewModel
class ConsentFormPdfViewModel @Inject constructor(
    private val getConsentFormPdf: GetConsentFormPdfUseCase,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val consentId: Int = checkNotNull(savedStateHandle["id"]).toString().toInt()

    private val _uiState = MutableStateFlow(ConsentFormPdfUiState())
    val uiState: StateFlow<ConsentFormPdfUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<ConsentFormPdfNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        loadPdf()
    }

    fun onEvent(event: ConsentFormPdfUiEvent) {
        when (event) {
            ConsentFormPdfUiEvent.NavigateBack -> viewModelScope.launch {
                _navEvent.send(ConsentFormPdfNavEvent.Back)
            }
        }
    }

    private fun loadPdf() {
        viewModelScope.launch {
            _uiState.value = ConsentFormPdfUiState(isLoading = true)
            when (val result = getConsentFormPdf(consentId)) {
                is Result.Success -> _uiState.value = ConsentFormPdfUiState(isLoading = false, pdfBytes = result.data)
                is Result.Error -> _uiState.value = ConsentFormPdfUiState(isLoading = false, error = result.message)
                Result.Loading -> Unit
            }
        }
    }
}

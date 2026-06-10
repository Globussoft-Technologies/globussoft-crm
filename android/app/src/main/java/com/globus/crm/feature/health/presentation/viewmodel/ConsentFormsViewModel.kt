package com.globus.crm.feature.health.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.health.domain.usecase.GetConsentFormsUseCase
import com.globus.crm.feature.health.presentation.state.ConsentFormsUiEvent
import com.globus.crm.feature.health.presentation.state.ConsentFormsUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class ConsentFormsNavEvent {
    data class ToPdf(val consentId: Int) : ConsentFormsNavEvent()
    object Back : ConsentFormsNavEvent()
}

@HiltViewModel
class ConsentFormsViewModel @Inject constructor(
    private val getConsentFormsUseCase: GetConsentFormsUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ConsentFormsUiState())
    val uiState: StateFlow<ConsentFormsUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<ConsentFormsNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        loadForms()
    }

    fun onEvent(event: ConsentFormsUiEvent) {
        when (event) {
            is ConsentFormsUiEvent.Refresh -> loadForms()
            is ConsentFormsUiEvent.ViewPdf -> viewModelScope.launch {
                _navEvent.send(ConsentFormsNavEvent.ToPdf(event.consentId))
            }
            is ConsentFormsUiEvent.NavigateBack -> viewModelScope.launch {
                _navEvent.send(ConsentFormsNavEvent.Back)
            }
        }
    }

    private fun loadForms() {
        viewModelScope.launch {
            _uiState.value = ConsentFormsUiState(isLoading = true)
            when (val result = getConsentFormsUseCase()) {
                is Result.Success -> _uiState.value = ConsentFormsUiState(
                    isLoading = false,
                    forms = result.data,
                )
                is Result.Error -> _uiState.value = ConsentFormsUiState(
                    isLoading = false,
                    error = result.message,
                )
                is Result.Loading -> Unit
            }
        }
    }
}

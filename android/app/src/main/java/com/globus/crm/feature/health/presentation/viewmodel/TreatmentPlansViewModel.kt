package com.globus.crm.feature.health.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.health.domain.usecase.GetTreatmentPlansUseCase
import com.globus.crm.feature.health.presentation.state.TreatmentPlansUiEvent
import com.globus.crm.feature.health.presentation.state.TreatmentPlansUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class TreatmentPlansNavEvent {
    object Back : TreatmentPlansNavEvent()
}

@HiltViewModel
class TreatmentPlansViewModel @Inject constructor(
    private val getTreatmentPlansUseCase: GetTreatmentPlansUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(TreatmentPlansUiState())
    val uiState: StateFlow<TreatmentPlansUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<TreatmentPlansNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        loadPlans()
    }

    fun onEvent(event: TreatmentPlansUiEvent) {
        when (event) {
            is TreatmentPlansUiEvent.Refresh -> loadPlans()
            is TreatmentPlansUiEvent.NavigateBack -> viewModelScope.launch {
                _navEvent.send(TreatmentPlansNavEvent.Back)
            }
        }
    }

    private fun loadPlans() {
        viewModelScope.launch {
            _uiState.value = TreatmentPlansUiState(isLoading = true)
            when (val result = getTreatmentPlansUseCase()) {
                is Result.Success -> _uiState.value = TreatmentPlansUiState(
                    isLoading = false,
                    plans = result.data,
                )
                is Result.Error -> _uiState.value = TreatmentPlansUiState(
                    isLoading = false,
                    error = result.message,
                )
                is Result.Loading -> Unit
            }
        }
    }
}

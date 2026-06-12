package com.globus.crm.feature.booking.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.booking.domain.usecase.GetVisitHistoryUseCase
import com.globus.crm.feature.booking.presentation.state.VisitHistoryUiEvent
import com.globus.crm.feature.booking.presentation.state.VisitHistoryUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class VisitHistoryNavEvent {
    object Back : VisitHistoryNavEvent()
}

@HiltViewModel
class VisitHistoryViewModel @Inject constructor(
    private val getVisitHistory: GetVisitHistoryUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(VisitHistoryUiState())
    val uiState: StateFlow<VisitHistoryUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<VisitHistoryNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        load()
    }

    fun onEvent(event: VisitHistoryUiEvent) {
        when (event) {
            VisitHistoryUiEvent.Refresh -> load()
            is VisitHistoryUiEvent.SelectVisit -> _uiState.value = _uiState.value.copy(selectedVisit = event.visit)
            VisitHistoryUiEvent.DismissDetail -> _uiState.value = _uiState.value.copy(selectedVisit = null)
            VisitHistoryUiEvent.NavigateBack -> viewModelScope.launch { _navEvent.send(VisitHistoryNavEvent.Back) }
        }
    }

    private fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            when (val result = getVisitHistory()) {
                is Result.Success -> _uiState.value = VisitHistoryUiState(
                    isLoading = false,
                    visits = result.data,
                )
                is Result.Error -> _uiState.value = VisitHistoryUiState(
                    isLoading = false,
                    error = result.message,
                )
                Result.Loading -> Unit
            }
        }
    }
}

package com.globussoft.wellness.feature.visits.presentation.visits

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Visit
import com.globussoft.wellness.feature.visits.domain.repository.VisitsRepository
import com.globussoft.wellness.feature.visits.presentation.visits.VisitsUiState.Companion.PAGE_SIZE
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class VisitsViewModel @Inject constructor(
    private val repository: VisitsRepository,
) : ViewModel() {

    private val _state   = MutableStateFlow(VisitsUiState())
    val state: StateFlow<VisitsUiState> = _state.asStateFlow()

    private val _effects = Channel<VisitsEffect>(Channel.BUFFERED)
    val effects: Flow<VisitsEffect> = _effects.receiveAsFlow()

    init { loadVisits(reset = true) }

    fun onEvent(event: VisitsEvent) {
        when (event) {
            is VisitsEvent.FromDateChanged  -> _state.update { it.copy(fromDate = event.date) }
            is VisitsEvent.ToDateChanged    -> _state.update { it.copy(toDate = event.date) }
            is VisitsEvent.ApplyFilter      -> loadVisits(reset = true)
            is VisitsEvent.ClearFilter      -> {
                _state.update { it.copy(fromDate = "", toDate = "") }
                loadVisits(reset = true)
            }
            is VisitsEvent.LoadNextPage     -> onLoadNextPage()
            is VisitsEvent.Refresh          -> loadVisits(reset = true)
            is VisitsEvent.VisitClicked     -> viewModelScope.launch {
                _effects.send(VisitsEffect.NavigateToPatient(event.patientId))
            }
        }
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    private fun loadVisits(reset: Boolean) {
        val currentState = _state.value
        val page = if (reset) 0 else currentState.currentPage + 1
        val skip = page * PAGE_SIZE

        if (!reset && currentState.isLoading) return
        if (!reset && currentState.hasReachedEnd) return

        _state.update { it.copy(isLoading = true, error = null, currentPage = page) }

        viewModelScope.launch {
            val from = currentState.fromDate.ifBlank { null }
            val to   = currentState.toDate.ifBlank { null }

            when (val result = repository.getVisits(from = from, to = to, skip = skip, limit = PAGE_SIZE)) {
                is WResult.Success -> {
                    _state.update { current ->
                        val merged = if (reset) result.data.visits
                                     else current.visits + result.data.visits
                        current.copy(
                            isLoading  = false,
                            visits     = merged,
                            totalCount = result.data.total,
                            error      = null,
                        )
                    }
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to load visits"
                    _state.update { it.copy(isLoading = false, error = msg) }
                    _effects.send(VisitsEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onLoadNextPage() {
        if (_state.value.isLoading || _state.value.hasReachedEnd) return
        loadVisits(reset = false)
    }
}

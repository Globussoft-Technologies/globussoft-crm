package com.globussoft.wellness.feature.crm.presentation.reports

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ReportsViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ReportsUiState())
    val state: StateFlow<ReportsUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun selectTab(index: Int) {
        _state.update { it.copy(selectedTab = index) }
    }

    fun setFromDate(date: String) {
        _state.update { it.copy(fromDate = date) }
        load()
    }

    fun setToDate(date: String) {
        _state.update { it.copy(toDate = date) }
        load()
    }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            val from = _state.value.fromDate.ifBlank { null }
            val to   = _state.value.toDate.ifBlank { null }

            val overviewDeferred    = async { repo.getReports(from = from, to = to) }
            val agentsDeferred      = async { repo.getAgentPerformance(from = from, to = to) }
            val winLossDeferred     = async { repo.getWinLoss(from = from, to = to) }
            val funnelDeferred      = async { repo.getFunnel() }

            val overviewResult    = overviewDeferred.await()
            val agentsResult      = agentsDeferred.await()
            val winLossResult     = winLossDeferred.await()
            val funnelResult      = funnelDeferred.await()

            _state.update { current ->
                val firstError = listOf(overviewResult, agentsResult, winLossResult, funnelResult)
                    .filterIsInstance<WResult.Error>()
                    .firstOrNull()

                current.copy(
                    isLoading        = false,
                    overview         = if (overviewResult is WResult.Success) overviewResult.data else current.overview,
                    agentPerformance = if (agentsResult  is WResult.Success) agentsResult.data  else current.agentPerformance,
                    winLoss          = if (winLossResult is WResult.Success) winLossResult.data  else current.winLoss,
                    funnel           = if (funnelResult  is WResult.Success) funnelResult.data   else current.funnel,
                    error            = firstError?.let { it.message ?: it.exception.message ?: "Failed to load reports" },
                )
            }
        }
    }
}

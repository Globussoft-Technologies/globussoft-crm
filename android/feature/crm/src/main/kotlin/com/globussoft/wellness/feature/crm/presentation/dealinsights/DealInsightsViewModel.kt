package com.globussoft.wellness.feature.crm.presentation.dealinsights

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.DealInsight
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class DealInsightsViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _allInsights = MutableStateFlow<List<DealInsight>>(emptyList())
    private val _state = MutableStateFlow(DealInsightsUiState())
    val state: StateFlow<DealInsightsUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun setRisk(risk: String?) {
        _state.update { it.copy(selectedRisk = risk) }
        applyFilter()
    }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = repo.getDealInsights()) {
                is WResult.Success -> {
                    _allInsights.value = result.data
                    _state.update { current ->
                        current.copy(
                            isLoading = false,
                            insights = filter(result.data, current.selectedRisk),
                        )
                    }
                }
                is WResult.Error -> {
                    _state.update {
                        it.copy(
                            isLoading = false,
                            error = result.message ?: result.exception.message,
                        )
                    }
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun applyFilter() {
        val risk = _state.value.selectedRisk
        _state.update { it.copy(insights = filter(_allInsights.value, risk)) }
    }

    private fun filter(all: List<DealInsight>, risk: String?) =
        if (risk == null) all else all.filter { it.riskLevel == risk }
}

package com.globussoft.wellness.feature.crm.presentation.dashboard

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
class CrmDashboardViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(CrmDashboardUiState())
    val state: StateFlow<CrmDashboardUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }

            val statsDeferred = async { repo.getDealStats() }
            val dealsDeferred = async { repo.getDeals(skip = 0) }

            val statsResult = statsDeferred.await()
            val dealsResult = dealsDeferred.await()

            _state.update { current ->
                current.copy(
                    isLoading   = false,
                    stats       = if (statsResult is WResult.Success) statsResult.data else current.stats,
                    recentDeals = if (dealsResult is WResult.Success) dealsResult.data else current.recentDeals,
                    error       = when {
                        statsResult is WResult.Error -> statsResult.message ?: statsResult.exception.message
                        dealsResult is WResult.Error -> dealsResult.message ?: dealsResult.exception.message
                        else                         -> null
                    },
                )
            }
        }
    }
}

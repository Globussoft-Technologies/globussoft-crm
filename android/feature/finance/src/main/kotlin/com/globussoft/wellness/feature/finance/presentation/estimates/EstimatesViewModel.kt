package com.globussoft.wellness.feature.finance.presentation.estimates

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.finance.domain.model.EstimateItem
import com.globussoft.wellness.feature.finance.domain.repository.FinanceRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class EstimatesUiState(
    val isLoading: Boolean = false,
    val estimates: List<EstimateItem> = emptyList(),
    val error: String? = null,
    val selectedStatus: String? = null,
)

@HiltViewModel
class EstimatesViewModel @Inject constructor(
    private val repository: FinanceRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(EstimatesUiState())
    val state: StateFlow<EstimatesUiState> = _state.asStateFlow()

    init { load() }

    fun setStatus(status: String?) {
        _state.update { it.copy(selectedStatus = status) }
        load()
    }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getEstimates(_state.value.selectedStatus)) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, estimates = r.data) }
                is WResult.Error   -> {
                    val msg = r.message ?: r.exception.message ?: "Failed to load estimates"
                    _state.update { it.copy(isLoading = false, error = msg) }
                }
                WResult.Loading -> Unit
            }
        }
    }
}

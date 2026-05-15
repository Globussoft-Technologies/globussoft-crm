package com.globussoft.wellness.feature.crm.presentation.forecasting

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ForecastingViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ForecastingUiState())
    val state: StateFlow<ForecastingUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = repo.getForecasting()) {
                is WResult.Success -> {
                    _state.update { it.copy(isLoading = false, entries = result.data) }
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
}

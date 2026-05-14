package com.globussoft.wellness.feature.admin.presentation.perlocation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.LocationKpi
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class PerLocationUiState(
    val isLoading: Boolean = false,
    val columns: List<LocationKpi> = emptyList(),
    val error: String? = null,
)

@HiltViewModel
class PerLocationViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(PerLocationUiState())
    val state: StateFlow<PerLocationUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getPerLocationKpis()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, columns = r.data) }
                is WResult.Error   -> {
                    val msg = r.message ?: r.exception.message ?: "Failed to load"
                    _state.update { it.copy(isLoading = false, error = msg) }
                }
                WResult.Loading -> Unit
            }
        }
    }
}

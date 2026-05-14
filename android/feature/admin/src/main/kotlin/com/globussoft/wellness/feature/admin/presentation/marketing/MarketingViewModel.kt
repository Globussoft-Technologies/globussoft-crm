package com.globussoft.wellness.feature.admin.presentation.marketing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class MarketingUiState(
    val isLoading: Boolean = false,
    val campaigns: List<Unit> = emptyList(),
    val error: String? = null,
)

@HiltViewModel
class MarketingViewModel @Inject constructor() : ViewModel() {

    private val _state = MutableStateFlow(MarketingUiState())
    val state: StateFlow<MarketingUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            // No working API for marketing — show empty state gracefully
            _state.update { it.copy(isLoading = false, campaigns = emptyList()) }
        }
    }
}

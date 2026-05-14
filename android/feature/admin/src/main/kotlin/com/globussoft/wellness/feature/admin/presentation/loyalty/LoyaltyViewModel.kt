package com.globussoft.wellness.feature.admin.presentation.loyalty

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class LoyaltyUiState(
    val isLoading: Boolean = false,
    val items: List<Unit> = emptyList(),
    val error: String? = null,
)

@HiltViewModel
class LoyaltyViewModel @Inject constructor() : ViewModel() {

    private val _state = MutableStateFlow(LoyaltyUiState())
    val state: StateFlow<LoyaltyUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            // No working API for loyalty — show empty state gracefully
            _state.update { it.copy(isLoading = false, items = emptyList()) }
        }
    }
}

package com.globussoft.wellness.feature.admin.presentation.convertedleads

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.ConvertedLeadItem
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ConvertedLeadsUiState(
    val isLoading: Boolean = false,
    val leads: List<ConvertedLeadItem> = emptyList(),
    val error: String? = null,
    val searchQuery: String = "",
)

@HiltViewModel
class ConvertedLeadsViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ConvertedLeadsUiState())
    val state: StateFlow<ConvertedLeadsUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    fun onSearch(query: String) {
        _state.update { it.copy(searchQuery = query) }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getConvertedLeads()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, leads = r.data) }
                is WResult.Error   -> {
                    val msg = r.message ?: r.exception.message ?: "Failed to load converted leads"
                    _state.update { it.copy(isLoading = false, error = msg) }
                }
                WResult.Loading -> Unit
            }
        }
    }
}

package com.globussoft.wellness.feature.admin.presentation.marketing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.CampaignItem
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class MarketingUiState(
    val isLoading: Boolean = false,
    val campaigns: List<CampaignItem> = emptyList(),
    val selectedChannel: String? = null,
    val error: String? = null,
)

@HiltViewModel
class MarketingViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(MarketingUiState())
    val state: StateFlow<MarketingUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    fun setChannel(channel: String?) {
        _state.update { it.copy(selectedChannel = channel) }
        load()
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getCampaigns(channel = _state.value.selectedChannel)) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, campaigns = r.data) }
                is WResult.Error   -> {
                    val msg = r.message ?: r.exception.message ?: "Failed to load campaigns"
                    _state.update { it.copy(isLoading = false, error = msg) }
                }
                WResult.Loading -> Unit
            }
        }
    }
}

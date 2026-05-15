package com.globussoft.wellness.feature.crm.presentation.marketing

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
class MarketingViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(MarketingUiState())
    val state: StateFlow<MarketingUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun selectTab(index: Int) {
        val channel = when (index) {
            1    -> "EMAIL"
            2    -> "SMS"
            else -> null
        }
        _state.update { it.copy(selectedTab = index, selectedChannel = channel) }
        load()
    }

    fun refresh() = load()

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }

            val result = repo.getCampaigns(channel = _state.value.selectedChannel)

            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(
                        isLoading = false,
                        campaigns = result.data,
                    )
                    is WResult.Error   -> current.copy(
                        isLoading = false,
                        error     = result.message ?: result.exception.message,
                    )
                    WResult.Loading    -> current.copy(isLoading = true)
                }
            }
        }
    }
}

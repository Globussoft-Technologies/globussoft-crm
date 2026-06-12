package com.globus.crm.feature.loyalty.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.loyalty.domain.usecase.GetLoyaltyUseCase
import com.globus.crm.feature.loyalty.presentation.state.LoyaltyUiEvent
import com.globus.crm.feature.loyalty.presentation.state.LoyaltyUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class LoyaltyNavEvent {
    object Back : LoyaltyNavEvent()
}

@HiltViewModel
class LoyaltyViewModel @Inject constructor(
    private val getLoyaltyUseCase: GetLoyaltyUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(LoyaltyUiState())
    val uiState: StateFlow<LoyaltyUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<LoyaltyNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        loadLoyalty()
    }

    fun onEvent(event: LoyaltyUiEvent) {
        when (event) {
            is LoyaltyUiEvent.Refresh -> loadLoyalty()
            is LoyaltyUiEvent.NavigateBack -> viewModelScope.launch {
                _navEvent.send(LoyaltyNavEvent.Back)
            }
        }
    }

    private fun loadLoyalty() {
        viewModelScope.launch {
            _uiState.value = LoyaltyUiState(isLoading = true)
            when (val result = getLoyaltyUseCase()) {
                is Result.Success -> _uiState.value = LoyaltyUiState(
                    isLoading = false,
                    loyaltyData = result.data,
                )
                is Result.Error -> _uiState.value = LoyaltyUiState(
                    isLoading = false,
                    error = result.message,
                )
                is Result.Loading -> Unit
            }
        }
    }
}

package com.globus.crm.feature.wallet.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.wallet.domain.usecase.GetMyTransactionsUseCase
import com.globus.crm.feature.wallet.presentation.state.WalletUiEvent
import com.globus.crm.feature.wallet.presentation.state.WalletUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class WalletNavEvent {
    object ToGiftCards : WalletNavEvent()
    object Back : WalletNavEvent()
}

@HiltViewModel
class WalletViewModel @Inject constructor(
    private val getMyTransactions: GetMyTransactionsUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(WalletUiState())
    val uiState: StateFlow<WalletUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<WalletNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        load()
    }

    fun onEvent(event: WalletUiEvent) {
        when (event) {
            WalletUiEvent.Refresh -> load()
            WalletUiEvent.NavigateToGiftCards -> viewModelScope.launch { _navEvent.send(WalletNavEvent.ToGiftCards) }
            WalletUiEvent.NavigateBack -> viewModelScope.launch { _navEvent.send(WalletNavEvent.Back) }
            is WalletUiEvent.FilterTransactions ->
                _uiState.value = _uiState.value.copy(activeFilter = event.type)
            is WalletUiEvent.SelectTransaction ->
                _uiState.value = _uiState.value.copy(selectedTransaction = event.transaction)
            WalletUiEvent.DismissTransactionDetail ->
                _uiState.value = _uiState.value.copy(selectedTransaction = null)
        }
    }

    private fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            when (val result = getMyTransactions()) {
                is Result.Success -> _uiState.value = WalletUiState(isLoading = false, wallet = result.data)
                is Result.Error -> _uiState.value = WalletUiState(isLoading = false, error = result.message)
                Result.Loading -> Unit
            }
        }
    }
}

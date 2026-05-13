package com.globussoft.wellness.feature.finance.presentation.giftcards

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.finance.domain.repository.FinanceRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class GiftCardsViewModel @Inject constructor(
    private val repository: FinanceRepository,
) : ViewModel() {

    private val _state   = MutableStateFlow(GiftCardsUiState())
    val state: StateFlow<GiftCardsUiState> = _state.asStateFlow()

    private val _effects = Channel<GiftCardsEffect>(Channel.BUFFERED)
    val effects: Flow<GiftCardsEffect> = _effects.receiveAsFlow()

    init { loadGiftCards() }

    fun onEvent(event: GiftCardsEvent) {
        when (event) {
            is GiftCardsEvent.Refresh           -> loadGiftCards()
            is GiftCardsEvent.FilterChanged     -> _state.update { it.copy(statusFilter = event.status) }
            is GiftCardsEvent.ShowIssueDialog   -> _state.update { it.copy(showIssueDialog = true, issueAmount = "") }
            is GiftCardsEvent.DismissIssueDialog -> _state.update { it.copy(showIssueDialog = false) }
            is GiftCardsEvent.IssuAmountChanged -> _state.update { it.copy(issueAmount = event.amount) }
            is GiftCardsEvent.ConfirmIssue      -> onConfirmIssue()
            is GiftCardsEvent.DismissNewCard    -> _state.update { it.copy(newlyIssuedCard = null) }
        }
    }

    private fun loadGiftCards() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = repository.getGiftCards()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, giftCards = result.data) }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to load gift cards"
                    _state.update { it.copy(isLoading = false, error = msg) }
                    _effects.send(GiftCardsEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onConfirmIssue() {
        val amount = _state.value.issueAmount.toDoubleOrNull()
        if (amount == null || amount <= 0.0) {
            viewModelScope.launch {
                _effects.send(GiftCardsEffect.ShowSnackbar("Enter a valid amount greater than 0"))
            }
            return
        }

        viewModelScope.launch {
            _state.update { it.copy(isIssuing = true) }
            when (val result = repository.issueGiftCard(amount)) {
                is WResult.Success -> {
                    _state.update { current ->
                        current.copy(
                            isIssuing       = false,
                            showIssueDialog = false,
                            newlyIssuedCard = result.data,
                            giftCards       = listOf(result.data) + current.giftCards,
                        )
                    }
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to issue gift card"
                    _state.update { it.copy(isIssuing = false) }
                    _effects.send(GiftCardsEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }
}

package com.globus.crm.feature.wallet.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.wallet.domain.usecase.ConfirmGiftCardPurchaseUseCase
import com.globus.crm.feature.wallet.domain.usecase.GetGiftCardStorefrontUseCase
import com.globus.crm.feature.wallet.domain.usecase.InitiateGiftCardPurchaseUseCase
import com.globus.crm.feature.wallet.presentation.state.GiftCardsUiEvent
import com.globus.crm.feature.wallet.presentation.state.GiftCardsUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class GiftCardsNavEvent {
    data class LaunchRazorpay(val orderId: String, val amount: Long, val currency: String, val key: String, val name: String) : GiftCardsNavEvent()
    object Back : GiftCardsNavEvent()
    object PurchaseComplete : GiftCardsNavEvent()
}

@HiltViewModel
class GiftCardsViewModel @Inject constructor(
    private val getStorefront: GetGiftCardStorefrontUseCase,
    private val initiateOrder: InitiateGiftCardPurchaseUseCase,
    private val confirmOrder: ConfirmGiftCardPurchaseUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(GiftCardsUiState())
    val uiState: StateFlow<GiftCardsUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<GiftCardsNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        load()
    }

    fun onEvent(event: GiftCardsUiEvent) {
        when (event) {
            GiftCardsUiEvent.Refresh -> load()
            is GiftCardsUiEvent.SelectCard -> _uiState.value = _uiState.value.copy(selectedCard = event.card, purchaseError = null)
            GiftCardsUiEvent.DismissCard -> _uiState.value = _uiState.value.copy(selectedCard = null, purchaseError = null)
            is GiftCardsUiEvent.InitiatePurchase -> initiatePurchase(event.giftCardId)
            is GiftCardsUiEvent.ConfirmPurchase -> confirmPurchase(event)
            GiftCardsUiEvent.NavigateBack -> viewModelScope.launch { _navEvent.send(GiftCardsNavEvent.Back) }
        }
    }

    private fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            when (val result = getStorefront()) {
                is Result.Success -> _uiState.value = GiftCardsUiState(isLoading = false, giftCards = result.data)
                is Result.Error -> _uiState.value = GiftCardsUiState(isLoading = false, error = result.message)
                Result.Loading -> Unit
            }
        }
    }

    private fun initiatePurchase(giftCardId: Int) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isPurchasing = true, purchaseError = null)
            when (val result = initiateOrder(giftCardId)) {
                is Result.Success -> {
                    _uiState.value = _uiState.value.copy(isPurchasing = false, pendingOrder = result.data)
                    _navEvent.send(
                        GiftCardsNavEvent.LaunchRazorpay(
                            orderId = result.data.orderId,
                            amount = result.data.amount,
                            currency = result.data.currency,
                            key = result.data.razorpayKey,
                            name = result.data.patientName,
                        )
                    )
                }
                is Result.Error -> _uiState.value = _uiState.value.copy(isPurchasing = false, purchaseError = result.message)
                Result.Loading -> Unit
            }
        }
    }

    private fun confirmPurchase(event: GiftCardsUiEvent.ConfirmPurchase) {
        val order = _uiState.value.pendingOrder ?: return
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isPurchasing = true)
            val result = confirmOrder(
                giftCardId = order.giftCardId,
                paymentId = event.paymentId,
                razorpayOrderId = event.razorpayOrderId,
                razorpayPaymentId = event.razorpayPaymentId,
                razorpaySignature = event.razorpaySignature,
            )
            when (result) {
                is Result.Success -> {
                    _uiState.value = _uiState.value.copy(isPurchasing = false, purchaseSuccess = true, selectedCard = null, pendingOrder = null)
                    _navEvent.send(GiftCardsNavEvent.PurchaseComplete)
                }
                is Result.Error -> _uiState.value = _uiState.value.copy(isPurchasing = false, purchaseError = result.message)
                Result.Loading -> Unit
            }
        }
    }
}

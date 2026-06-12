package com.globus.crm.feature.finance.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.network.WellnessApiService
import com.globus.crm.core.util.Result
import com.globus.crm.feature.finance.domain.usecase.GetPaymentsUseCase
import com.globus.crm.feature.finance.presentation.state.FinanceUiEvent
import com.globus.crm.feature.finance.presentation.state.FinanceUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class FinanceNavEvent {
    object ToGiftCards : FinanceNavEvent()
    object ToWallet : FinanceNavEvent()
}

@HiltViewModel
class FinanceViewModel @Inject constructor(
    private val getPaymentsUseCase: GetPaymentsUseCase,
    private val apiService: WellnessApiService,
) : ViewModel() {

    private val _uiState = MutableStateFlow(FinanceUiState())
    val uiState: StateFlow<FinanceUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<FinanceNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        loadPayments()
    }

    fun onEvent(event: FinanceUiEvent) {
        when (event) {
            FinanceUiEvent.LoadPayments -> loadPayments()
            FinanceUiEvent.NavigateToGiftCards ->
                viewModelScope.launch { _navEvent.send(FinanceNavEvent.ToGiftCards) }
            FinanceUiEvent.NavigateToWallet ->
                viewModelScope.launch { _navEvent.send(FinanceNavEvent.ToWallet) }
            is FinanceUiEvent.SelectPayment ->
                _uiState.value = _uiState.value.copy(selectedPayment = event.payment)
            FinanceUiEvent.DismissPaymentSheet ->
                _uiState.value = _uiState.value.copy(selectedPayment = null, refundError = null)
            is FinanceUiEvent.RequestRefund ->
                _uiState.value = _uiState.value.copy(showRefundConfirmFor = event.payment, selectedPayment = null)
            FinanceUiEvent.DismissRefundConfirm ->
                _uiState.value = _uiState.value.copy(showRefundConfirmFor = null, refundError = null)
            FinanceUiEvent.ConfirmRefund -> confirmRefund()
        }
    }

    private fun loadPayments() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            when (val result = getPaymentsUseCase()) {
                is Result.Success -> _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    payments = result.data,
                )
                is Result.Error -> _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    error = result.message,
                )
                Result.Loading -> Unit
            }
        }
    }

    private fun confirmRefund() {
        val payment = _uiState.value.showRefundConfirmFor ?: return
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isRefunding = true, refundError = null)
            try {
                val response = apiService.refundPayment(payment.id.toString())
                if (response.isSuccessful) {
                    _uiState.value = _uiState.value.copy(
                        isRefunding = false,
                        showRefundConfirmFor = null,
                    )
                    loadPayments()
                } else {
                    val msg = when (response.code()) {
                        403 -> "You don't have permission to refund this payment"
                        404 -> "Payment not found"
                        else -> "Refund failed. Please try again."
                    }
                    _uiState.value = _uiState.value.copy(isRefunding = false, refundError = msg)
                }
            } catch (_: Exception) {
                _uiState.value = _uiState.value.copy(
                    isRefunding = false,
                    refundError = "Network error. Please try again.",
                )
            }
        }
    }
}

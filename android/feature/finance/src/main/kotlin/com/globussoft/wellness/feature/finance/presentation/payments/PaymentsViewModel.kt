package com.globussoft.wellness.feature.finance.presentation.payments

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.finance.domain.model.PaymentItem
import com.globussoft.wellness.feature.finance.domain.repository.FinanceRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class PaymentsUiState(
    val isLoading: Boolean = false,
    val payments: List<PaymentItem> = emptyList(),
    val error: String? = null,
    val gatewayFilter: String? = null,
)

@HiltViewModel
class PaymentsViewModel @Inject constructor(
    private val repository: FinanceRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(PaymentsUiState())
    val state: StateFlow<PaymentsUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    fun setGatewayFilter(gateway: String?) {
        _state.update { it.copy(gatewayFilter = gateway) }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getPayments()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, payments = r.data) }
                is WResult.Error   -> {
                    val msg = r.message ?: r.exception.message ?: "Failed to load payments"
                    _state.update { it.copy(isLoading = false, error = msg) }
                }
                WResult.Loading -> Unit
            }
        }
    }
}

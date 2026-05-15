package com.globussoft.wellness.feature.crm.presentation.payments

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.util.safeApiCall

import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class PaymentsViewModel @Inject constructor(
    @Suppress("UnusedPrivateMember")
    private val repo: CrmRepository,
    private val api: WellnessApi,
) : ViewModel() {

    private val _state = MutableStateFlow(PaymentsUiState())
    val state: StateFlow<PaymentsUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun refresh() = load()

    fun setMethod(method: String?) {
        _state.update { it.copy(selectedMethod = method) }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = safeApiCall { api.getPayments() }) {
                is WResult.Success -> {
                    val list  = result.data
                    val total = list.sumOf { it.amount ?: 0.0 }
                    _state.update { it.copy(isLoading = false, payments = list, totalCollected = total) }
                }
                is WResult.Error   -> {
                    _state.update {
                        it.copy(
                            isLoading = false,
                            error     = result.message ?: result.exception.message ?: "Failed to load payments",
                        )
                    }
                }
                WResult.Loading    -> Unit
            }
        }
    }
}

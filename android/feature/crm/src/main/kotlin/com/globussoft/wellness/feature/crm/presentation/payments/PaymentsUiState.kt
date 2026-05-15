package com.globussoft.wellness.feature.crm.presentation.payments

import com.globussoft.wellness.core.network.model.response.PaymentResponse

data class PaymentsUiState(
    val isLoading: Boolean = false,
    val payments: List<PaymentResponse> = emptyList(),
    val totalCollected: Double = 0.0,
    val error: String? = null,
    val selectedMethod: String? = null,
)

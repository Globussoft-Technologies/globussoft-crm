package com.globus.crm.feature.finance.domain.repository

import com.globus.crm.feature.finance.domain.model.Payment
import com.globus.crm.feature.finance.domain.model.PaymentConfig

interface FinanceRepository {
    suspend fun getPayments(): List<Payment>
    suspend fun getPaymentConfig(): PaymentConfig?
}

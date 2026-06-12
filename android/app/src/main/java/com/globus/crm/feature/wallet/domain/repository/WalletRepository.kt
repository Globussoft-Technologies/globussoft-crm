package com.globus.crm.feature.wallet.domain.repository

import com.globus.crm.feature.wallet.domain.model.GiftCard
import com.globus.crm.feature.wallet.domain.model.GiftCardOrder
import com.globus.crm.feature.wallet.domain.model.WalletSummary

interface WalletRepository {
    suspend fun getWalletSummary(patientId: Int): WalletSummary
    suspend fun getMyTransactions(): WalletSummary
}

interface GiftCardRepository {
    suspend fun getStorefront(): List<GiftCard>
    suspend fun initiateOrder(giftCardId: Int, patientId: Int): GiftCardOrder
    suspend fun confirmOrder(
        giftCardId: Int,
        paymentId: String,
        razorpayOrderId: String,
        razorpayPaymentId: String,
        razorpaySignature: String,
    ): GiftCard
}

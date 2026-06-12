package com.globus.crm.feature.wallet.presentation.state

import com.globus.crm.feature.wallet.domain.model.GiftCard
import com.globus.crm.feature.wallet.domain.model.GiftCardOrder
import com.globus.crm.feature.wallet.domain.model.Transaction
import com.globus.crm.feature.wallet.domain.model.WalletSummary

data class WalletUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val wallet: WalletSummary? = null,
    val activeFilter: String = "All",
    val selectedTransaction: Transaction? = null,
)

sealed class WalletUiEvent {
    object Refresh : WalletUiEvent()
    object NavigateToGiftCards : WalletUiEvent()
    object NavigateBack : WalletUiEvent()
    data class FilterTransactions(val type: String) : WalletUiEvent()
    data class SelectTransaction(val transaction: Transaction) : WalletUiEvent()
    object DismissTransactionDetail : WalletUiEvent()
}

data class GiftCardsUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val giftCards: List<GiftCard> = emptyList(),
    val selectedCard: GiftCard? = null,
    val pendingOrder: GiftCardOrder? = null,
    val isPurchasing: Boolean = false,
    val purchaseError: String? = null,
    val purchaseSuccess: Boolean = false,
)

sealed class GiftCardsUiEvent {
    object Refresh : GiftCardsUiEvent()
    data class SelectCard(val card: GiftCard) : GiftCardsUiEvent()
    object DismissCard : GiftCardsUiEvent()
    data class InitiatePurchase(val giftCardId: Int) : GiftCardsUiEvent()
    data class ConfirmPurchase(
        val paymentId: String,
        val razorpayOrderId: String,
        val razorpayPaymentId: String,
        val razorpaySignature: String,
    ) : GiftCardsUiEvent()
    object NavigateBack : GiftCardsUiEvent()
}

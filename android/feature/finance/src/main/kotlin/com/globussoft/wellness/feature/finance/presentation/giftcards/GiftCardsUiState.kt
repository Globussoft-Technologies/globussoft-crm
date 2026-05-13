package com.globussoft.wellness.feature.finance.presentation.giftcards

import com.globussoft.wellness.feature.finance.domain.model.GiftCard

/**
 * Immutable UI state for the Gift Cards screen.
 *
 * [newlyIssuedCard] is set for exactly one render cycle after a successful
 * issuance — the UI shows it in a highlighted "one-time display" card with a
 * copy button.  Navigating away or tapping "Done" clears it.
 */
data class GiftCardsUiState(
    val isLoading: Boolean = false,
    val giftCards: List<GiftCard> = emptyList(),
    /** Active status filter: null = all, else one of ACTIVE/REDEEMED/EXPIRED/CANCELLED. */
    val statusFilter: String? = null,
    /** Controls the "Issue Gift Card" amount input dialog. */
    val showIssueDialog: Boolean = false,
    /** Amount text bound to the issue dialog input. */
    val issueAmount: String = "",
    /** True while the issue POST is in flight. */
    val isIssuing: Boolean = false,
    /** Set after a successful issue — drives the one-time code card. */
    val newlyIssuedCard: GiftCard? = null,
    val error: String? = null,
) {
    /** Gift cards filtered by the active [statusFilter]. */
    val filteredCards: List<GiftCard>
        get() = if (statusFilter == null) giftCards
                else giftCards.filter { it.status.uppercase() == statusFilter.uppercase() }
}

// ─── Events ───────────────────────────────────────────────────────────────────

sealed class GiftCardsEvent {
    data object Refresh : GiftCardsEvent()
    data class FilterChanged(val status: String?) : GiftCardsEvent()
    data object ShowIssueDialog : GiftCardsEvent()
    data object DismissIssueDialog : GiftCardsEvent()
    data class IssuAmountChanged(val amount: String) : GiftCardsEvent()
    data object ConfirmIssue : GiftCardsEvent()
    data object DismissNewCard : GiftCardsEvent()
}

// ─── Effects ──────────────────────────────────────────────────────────────────

sealed class GiftCardsEffect {
    data class ShowSnackbar(val message: String) : GiftCardsEffect()
    data class CopyToClipboard(val text: String) : GiftCardsEffect()
}

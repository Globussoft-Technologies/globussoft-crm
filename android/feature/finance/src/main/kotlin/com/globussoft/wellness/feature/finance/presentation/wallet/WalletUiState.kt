package com.globussoft.wellness.feature.finance.presentation.wallet

import com.globussoft.wellness.feature.finance.domain.model.WalletData
import com.globussoft.wellness.feature.finance.domain.model.WalletTransaction

/**
 * Immutable UI state for the Wallet screen.
 *
 * The screen starts with an empty search prompt.  Once the user selects a
 * patient from search results, [walletData] is populated and the balance card
 * + ledger table are rendered.
 */
data class WalletUiState(
    /** True while the patient-wallet fetch is in flight. */
    val isLoading: Boolean = false,
    /** Current text in the patient search field. */
    val searchQuery: String = "",
    /** Simulated search results — patient name/phone pairs fetched from the backend. */
    val searchResults: List<PatientSearchResult> = emptyList(),
    /** True while the patient search results dropdown is shown. */
    val showSearchDropdown: Boolean = false,
    /** ID of the currently selected patient; empty string means no selection. */
    val selectedPatientId: String = "",
    /** Display name of the currently selected patient. */
    val selectedPatientName: String = "",
    /** Wallet data for the selected patient; null until a patient is selected. */
    val walletData: WalletData? = null,
    /** Non-null when the wallet fetch fails. */
    val error: String? = null,
)

/** Minimal patient result returned from the backend search. */
data class PatientSearchResult(
    val id: String,
    val name: String,
    val phone: String,
)

// ─── Events ───────────────────────────────────────────────────────────────────

sealed class WalletEvent {
    data class SearchChanged(val query: String) : WalletEvent()
    data class PatientSelected(val id: String, val name: String) : WalletEvent()
    data object DismissDropdown : WalletEvent()
}

// ─── Effects ──────────────────────────────────────────────────────────────────

sealed class WalletEffect {
    data class ShowSnackbar(val message: String) : WalletEffect()
}

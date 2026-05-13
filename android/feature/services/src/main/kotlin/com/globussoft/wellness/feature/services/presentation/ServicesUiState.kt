package com.globussoft.wellness.feature.services.presentation

import com.globussoft.wellness.core.domain.model.Service

// ─── UI State ─────────────────────────────────────────────────────────────────

/**
 * Immutable snapshot of the Services screen state managed by [ServicesViewModel].
 *
 * The screen has three tabs: Catalog, Packages (static placeholder), and
 * Active Treatments (read-only list derived from visit data in a future
 * iteration — currently shows a placeholder).
 *
 * @param isLoading           True while a network operation is in flight.
 * @param services            Full service catalog for the Catalog tab.
 * @param error               Non-null error message shown when set.
 * @param selectedTabIndex    0=Catalog, 1=Packages, 2=Active Treatments.
 * @param showAddForm         True when the add/edit bottom sheet is open.
 * @param editingService      Non-null when the sheet is in edit mode.
 * @param formState           Current state of the add/edit form fields.
 * @param deleteConfirmService Non-null when the delete confirmation dialog is visible.
 */
data class ServicesUiState(
    val isLoading: Boolean = false,
    val services: List<Service> = emptyList(),
    val error: String? = null,
    val selectedTabIndex: Int = 0,
    val showAddForm: Boolean = false,
    val editingService: Service? = null,
    val formState: ServiceFormState = ServiceFormState(),
    val deleteConfirmService: Service? = null,
)

/**
 * Mutable form state for the add/edit service bottom sheet.
 *
 * [basePrice] and [durationMin] are stored as [String] to allow free-form
 * numeric input from OutlinedTextField without conversion errors mid-typing.
 *
 * Validation errors are set on the corresponding `*Error` fields; the ViewModel
 * clears them when the field changes.
 */
data class ServiceFormState(
    val name: String = "",
    val category: String = "",
    val ticketTier: String = "medium",
    val basePrice: String = "",
    val durationMin: String = "30",
    val targetRadiusKm: String = "",
    val description: String = "",
    val nameError: String? = null,
    val priceError: String? = null,
)

// ─── Events ───────────────────────────────────────────────────────────────────

/**
 * Exhaustive set of user-initiated events on the Services screen.
 */
sealed class ServicesEvent {

    /** User tapped a tab in the [WellnessTabStrip]. */
    data class TabSelected(val index: Int) : ServicesEvent()

    /**
     * Opens the add form (if currently closed) or closes it (if open).
     * Resets [ServicesUiState.formState] when toggling closed.
     */
    data object ToggleAddForm : ServicesEvent()

    /**
     * Updates a single field in the add/edit form by [field] name.
     *
     * Recognised field names: "name", "category", "ticketTier",
     * "basePrice", "durationMin", "targetRadiusKm", "description".
     */
    data class FormFieldChanged(val field: String, val value: String) : ServicesEvent()

    /** User pressed the submit button in the add/edit bottom sheet. */
    data object SubmitForm : ServicesEvent()

    /** User tapped the edit icon on a service card. */
    data class EditService(val service: Service) : ServicesEvent()

    /** User tapped the delete icon; triggers the confirm dialog. */
    data class DeleteRequested(val service: Service) : ServicesEvent()

    /** User confirmed deletion in the dialog. */
    data object ConfirmDelete : ServicesEvent()

    /** User dismissed the delete dialog without confirming. */
    data object DismissDelete : ServicesEvent()

    /** Pull-to-refresh or explicit retry. */
    data object Refresh : ServicesEvent()
}

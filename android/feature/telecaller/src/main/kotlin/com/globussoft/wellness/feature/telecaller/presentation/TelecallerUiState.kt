package com.globussoft.wellness.feature.telecaller.presentation

import com.globussoft.wellness.core.domain.model.Lead

/**
 * Immutable UI state for the Telecaller Queue screen.
 *
 * [queue]                — ordered list of leads awaiting disposition.
 * [currentLead]          — the lead currently displayed in the detail pane.
 * [showDispositionSheet] — whether the bottom sheet is open.
 * [selectedDisposition]  — which [DispositionType] button was most recently tapped.
 * [dispositionForm]      — form fields for the selected disposition type.
 * [showConfirmDialog]    — whether the destructive-action confirm dialog is showing.
 * [isSubmitting]         — true while the disposition API call is in flight.
 */
data class TelecallerUiState(
    val isLoading: Boolean = false,
    val queue: List<Lead> = emptyList(),
    val currentLead: Lead? = null,
    val error: String? = null,
    val showDispositionSheet: Boolean = false,
    val selectedDisposition: DispositionType? = null,
    val dispositionForm: DispositionFormState = DispositionFormState(),
    val showConfirmDialog: Boolean = false,
    val isSubmitting: Boolean = false,
    val submitError: String? = null,
)

/**
 * Form field state for the disposition bottom sheet.
 *
 * Only the fields relevant to the selected [DispositionType] are shown in the UI,
 * but all are stored here so the form doesn't reset if the user switches types
 * and comes back.
 */
data class DispositionFormState(
    val notes: String = "",
    val callbackDateTime: String = "",
    val appointmentService: String = "",
    val appointmentTime: String = "",
)

/**
 * The six disposition outcomes available to a telecaller.
 *
 * [label]         — human-readable button label.
 * [isDestructive] — when true, the action removes the lead from the queue
 *                   and requires an additional confirmation step.
 * [apiType]       — the string sent in [DispositionRequest.type] to the backend.
 */
enum class DispositionType(
    val label: String,
    val isDestructive: Boolean,
    val apiType: String,
) {
    INTERESTED("Interested",          isDestructive = false, apiType = "INTERESTED"),
    CALLBACK(  "Schedule Callback",   isDestructive = false, apiType = "CALLBACK"),
    BOOKED(    "Booked Appointment",  isDestructive = false, apiType = "APPOINTMENT_BOOKED"),
    NOT_INTERESTED("Not Interested",  isDestructive = false, apiType = "NOT_INTERESTED"),
    WRONG_NUMBER(  "Wrong Number",    isDestructive = true,  apiType = "WRONG_NUMBER"),
    JUNK(          "Mark as Junk",    isDestructive = true,  apiType = "DND"),
}

/**
 * User intents for the Telecaller Queue screen.
 */
sealed class TelecallerEvent {
    /** The user tapped one of the 6 disposition buttons. */
    data class SelectDisposition(val type: DispositionType) : TelecallerEvent()

    /** A form field inside the disposition bottom sheet changed. */
    data class FormFieldChanged(val field: String, val value: String) : TelecallerEvent()

    /** The user tapped Submit on a destructive disposition to trigger the confirm dialog. */
    data object ShowConfirmDialog : TelecallerEvent()

    /** The user confirmed the destructive disposition in the dialog. */
    data object ConfirmDisposition : TelecallerEvent()

    /** The user dismissed the disposition bottom sheet. */
    data object DismissSheet : TelecallerEvent()

    /** The user dismissed the confirm dialog without confirming. */
    data object DismissConfirm : TelecallerEvent()

    /** The user tapped Refresh or pull-to-refreshed. */
    data object RefreshQueue : TelecallerEvent()

    /** The user selected a different lead from the queue list pane. */
    data class LoadLead(val leadId: String) : TelecallerEvent()

    /** The user tapped Submit on a non-destructive disposition bottom sheet. */
    data object SubmitDisposition : TelecallerEvent()
}

/**
 * One-time side effects emitted by [TelecallerViewModel].
 */
sealed class TelecallerEffect {
    /** Show a transient Snackbar message. */
    data class ShowSnackbar(val message: String) : TelecallerEffect()
}

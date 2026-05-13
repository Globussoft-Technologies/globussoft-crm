package com.globussoft.wellness.feature.visits.presentation.leave

import com.globussoft.wellness.feature.visits.domain.model.LeaveRequest

/**
 * Immutable UI state for the Leave screen.
 *
 * [myRequests] shows the current user's own leave history.
 * [allRequests] is populated (and rendered) only for MANAGER / ADMIN users;
 * it includes requests from all staff with approve/reject buttons.
 *
 * [showApplySheet] controls the "Apply for Leave" ModalBottomSheet.
 */
data class LeaveUiState(
    val isLoading: Boolean = false,
    val myRequests: List<LeaveRequest> = emptyList(),
    val allRequests: List<LeaveRequest> = emptyList(),
    val isManager: Boolean = false,
    val error: String? = null,

    // ─── Apply sheet ─────────────────────────────────────────────────────────
    val showApplySheet: Boolean = false,
    val applyForm: LeaveFormState = LeaveFormState(),
    val isSubmitting: Boolean = false,

    // ─── Approve / Reject in-progress tracking ─────────────────────────────
    /** ID of the request currently being approved/rejected; null when idle. */
    val processingId: String? = null,
)

/**
 * Field state for the "Apply for Leave" form.
 */
data class LeaveFormState(
    val fromDate: String = "",
    val toDate: String = "",
    /** ANNUAL / SICK / UNPAID */
    val type: String = "ANNUAL",
    val reason: String = "",
    val fromDateError: String? = null,
    val toDateError: String? = null,
    val reasonError: String? = null,
)

// ─── Events ───────────────────────────────────────────────────────────────────

sealed class LeaveEvent {
    data object Refresh : LeaveEvent()
    data object ShowApplySheet : LeaveEvent()
    data object DismissApplySheet : LeaveEvent()
    data class FormFieldChanged(val field: String, val value: String) : LeaveEvent()
    data object SubmitLeave : LeaveEvent()
    data class ApproveRequest(val id: String) : LeaveEvent()
    data class RejectRequest(val id: String) : LeaveEvent()
}

// ─── Effects ──────────────────────────────────────────────────────────────────

sealed class LeaveEffect {
    data class ShowSnackbar(val message: String) : LeaveEffect()
}

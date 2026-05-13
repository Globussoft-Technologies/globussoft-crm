package com.globussoft.wellness.feature.finance.presentation.coupons

import com.globussoft.wellness.feature.finance.domain.model.Coupon
import com.globussoft.wellness.feature.finance.domain.model.CouponPreview

/**
 * Immutable UI state for the Coupons screen.
 *
 * The screen has three overlapping overlay surfaces:
 * 1. [showFormSheet] — add/edit ModalBottomSheet.
 * 2. [showPreviewDialog] — "Preview Code" dialog showing discount math.
 * 3. [deleteTargetId] — confirmation dialog before deletion.
 */
data class CouponsUiState(
    val isLoading: Boolean = false,
    val coupons: List<Coupon> = emptyList(),
    val error: String? = null,

    // ─── Add / Edit form ─────────────────────────────────────────────────────
    val showFormSheet: Boolean = false,
    /** Non-null when editing an existing coupon; null for "create new". */
    val editingCoupon: Coupon? = null,
    val formState: CouponFormState = CouponFormState(),
    val isSaving: Boolean = false,

    // ─── Preview dialog ───────────────────────────────────────────────────────
    val showPreviewDialog: Boolean = false,
    val previewCode: String = "",
    val previewAmount: String = "",
    val previewResult: CouponPreview? = null,
    val isPreviewing: Boolean = false,

    // ─── Delete confirmation ──────────────────────────────────────────────────
    val deleteTargetId: String? = null,
    val isDeleting: Boolean = false,
)

/**
 * Form fields for the add/edit coupon ModalBottomSheet.
 *
 * All numeric/date values are stored as [String] to bind to text fields without
 * extra conversion.  Parsing and validation happen in the ViewModel on submit.
 */
data class CouponFormState(
    val code: String = "",
    val discountType: String = "PERCENT",
    val amount: String = "",
    val minOrderAmount: String = "",
    val maxRedemptions: String = "",
    val expiryDate: String = "",
    val isActive: Boolean = true,
    val codeError: String? = null,
    val amountError: String? = null,
)

// ─── Events ───────────────────────────────────────────────────────────────────

sealed class CouponsEvent {
    data object Refresh : CouponsEvent()

    // Form sheet
    data object ShowNewForm : CouponsEvent()
    data class ShowEditForm(val coupon: Coupon) : CouponsEvent()
    data object DismissForm : CouponsEvent()
    data class FormFieldChanged(val field: String, val value: String) : CouponsEvent()
    data class ActiveToggled(val isActive: Boolean) : CouponsEvent()
    data object SubmitForm : CouponsEvent()

    // Preview dialog
    data object ShowPreviewDialog : CouponsEvent()
    data object DismissPreviewDialog : CouponsEvent()
    data class PreviewFieldChanged(val field: String, val value: String) : CouponsEvent()
    data object SubmitPreview : CouponsEvent()

    // Delete
    data class RequestDelete(val id: String) : CouponsEvent()
    data object ConfirmDelete : CouponsEvent()
    data object DismissDelete : CouponsEvent()
}

// ─── Effects ──────────────────────────────────────────────────────────────────

sealed class CouponsEffect {
    data class ShowSnackbar(val message: String) : CouponsEffect()
}

package com.globussoft.wellness.feature.finance.presentation.pos

import com.globussoft.wellness.feature.finance.domain.model.PosLineItem
import com.globussoft.wellness.feature.finance.domain.model.PosReceiptData

/**
 * Immutable UI state snapshot for the POS screen.
 *
 * The screen has two top-level modes driven by [shiftOpen]:
 * - `false` → shows the "Open Shift" card.
 * - `true`  → shows the full two-column sale entry layout.
 *
 * Discount math is recomputed inside [PosViewModel] on every state update so
 * [finalAmount] always reflects the current [lineItems] + [discountType] +
 * [discountValue] combination.
 */
data class PosUiState(
    /** True while any network call is in flight. */
    val isLoading: Boolean = false,
    /** Whether a shift is currently open on this register. */
    val shiftOpen: Boolean = false,
    /** Display name of the register (informational only — sent with the sale). */
    val registerId: String = "Register 1",
    /** Opening float input for the shift-open form. */
    val openingFloat: String = "",
    /** Accumulated line items for the current sale. */
    val lineItems: List<PosLineItem> = emptyList(),
    /** Bound fields for the "add a line item" sub-form. */
    val currentItemForm: PosItemForm = PosItemForm(),
    /** Patient ID for the current sale; empty string means guest or no patient. */
    val patientId: String = "",
    /** Display name of the searched patient. */
    val patientName: String = "",
    /** True when the sale is for an unregistered walk-in (skips patient field). */
    val isGuestCheckout: Boolean = false,
    /** How the order-level discount is calculated: none / percent / flat / coupon. */
    val discountType: String = "none",
    /** Raw text input for the discount value (percentage, flat amount, or coupon code). */
    val discountValue: String = "",
    /** Selected payment method for the sale. */
    val paymentMethod: String = "CASH",
    /** Final billed amount after all discounts. */
    val finalAmount: Double = 0.0,
    /** True while the sale POST is in flight — disables the submit button. */
    val isSubmitting: Boolean = false,
    /** Set when the last sale completed successfully; drives the receipt card. */
    val lastReceipt: PosReceiptData? = null,
    /** Non-null when any operation fails. */
    val error: String? = null,
) {
    /** Raw sum of all line items before any order-level discount. */
    val subtotal: Double get() = lineItems.sumOf { it.subtotal }

    /** Computed order-level discount amount. */
    val discountAmount: Double
        get() {
            val v = discountValue.toDoubleOrNull() ?: 0.0
            return when (discountType) {
                "percent" -> subtotal * (v / 100.0)
                "flat"    -> v.coerceAtMost(subtotal)
                else      -> 0.0  // "none" and "coupon" (coupon preview handled separately)
            }
        }
}

/**
 * Mutable form state for the "add line item" sub-form on the POS screen.
 *
 * All numeric fields are stored as [String] so the user can type fractional
 * values freely; parsing happens in the ViewModel at [PosEvent.AddLineItem].
 */
data class PosItemForm(
    /** SERVICE / PRODUCT / MEMBERSHIP / PACKAGE / GIFT_CARD */
    val lineType: String = "SERVICE",
    val name: String = "",
    val qty: String = "1",
    val unitPrice: String = "",
    val lineDiscount: String = "0",
)

// ─── Events ───────────────────────────────────────────────────────────────────

/** All user intents that can mutate the POS screen. */
sealed class PosEvent {

    /** User tapped "Open Shift" with the given register id and opening float. */
    data class OpenShift(
        val registerId: String,
        val openingFloat: String,
    ) : PosEvent()

    /** User confirmed the shift-close dialog with the physical cash count. */
    data class CloseShift(val closingAmount: String) : PosEvent()

    /**
     * A field inside the line-item sub-form was changed.
     * [field] is one of: lineType / name / qty / unitPrice / lineDiscount.
     */
    data class ItemFormChanged(val field: String, val value: String) : PosEvent()

    /** User tapped "Add Item" — validates and appends [currentItemForm] to [lineItems]. */
    data object AddLineItem : PosEvent()

    /** User tapped the delete icon on a line item at [index]. */
    data class RemoveLineItem(val index: Int) : PosEvent()

    /** Discount type or value changed. */
    data class DiscountChanged(val type: String, val value: String) : PosEvent()

    /** User selected a payment method chip. */
    data class PaymentMethodChanged(val method: String) : PosEvent()

    /** Guest checkout toggle was flipped. */
    data class GuestCheckoutToggled(val isGuest: Boolean) : PosEvent()

    /** Patient lookup result selected from search. */
    data class PatientChanged(val id: String, val name: String) : PosEvent()

    /** User tapped "Complete Sale". */
    data object SubmitSale : PosEvent()

    /** User tapped "New Sale" on the receipt card — clears the last receipt. */
    data object DismissReceipt : PosEvent()
}

// ─── Effects ──────────────────────────────────────────────────────────────────

/** One-time side effects emitted to the POS screen. */
sealed class PosEffect {
    data class ShowSnackbar(val message: String) : PosEffect()
}

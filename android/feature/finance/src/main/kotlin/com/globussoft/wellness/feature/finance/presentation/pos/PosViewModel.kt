package com.globussoft.wellness.feature.finance.presentation.pos

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.finance.domain.model.PosLineItem
import com.globussoft.wellness.feature.finance.domain.model.PosSubmitRequest
import com.globussoft.wellness.feature.finance.domain.repository.FinanceRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the POS screen.
 *
 * ### Shift lifecycle
 * [openShift] sends a POST to the server and flips [PosUiState.shiftOpen] to
 * `true` on success.  [closeShift] does the reverse.  Both are network calls —
 * there is no local-only shift state.
 *
 * ### Running total
 * [PosUiState.subtotal], [PosUiState.discountAmount], and [PosUiState.finalAmount]
 * are derived from [PosUiState.lineItems] + discount inputs.  [_state] is updated
 * after every [AddLineItem], [RemoveLineItem], and [DiscountChanged] event so the
 * right column always shows live totals without an extra calculation step.
 *
 * ### Submit validation
 * [SubmitSale] requires at least one line item.  A blank [patientId] is allowed
 * when [isGuestCheckout] is true.
 */
@HiltViewModel
class PosViewModel @Inject constructor(
    private val repository: FinanceRepository,
) : ViewModel() {

    private val _state   = MutableStateFlow(PosUiState())
    val state: StateFlow<PosUiState> = _state.asStateFlow()

    private val _effects = Channel<PosEffect>(Channel.BUFFERED)
    val effects: Flow<PosEffect> = _effects.receiveAsFlow()

    // ─── Public event dispatcher ──────────────────────────────────────────────

    fun onEvent(event: PosEvent) {
        when (event) {
            is PosEvent.OpenShift             -> onOpenShift(event.registerId, event.openingFloat)
            is PosEvent.CloseShift            -> onCloseShift(event.closingAmount)
            is PosEvent.ItemFormChanged       -> onItemFormChanged(event.field, event.value)
            is PosEvent.AddLineItem           -> onAddLineItem()
            is PosEvent.RemoveLineItem        -> onRemoveLineItem(event.index)
            is PosEvent.DiscountChanged       -> onDiscountChanged(event.type, event.value)
            is PosEvent.PaymentMethodChanged  -> _state.update { it.copy(paymentMethod = event.method) }
            is PosEvent.GuestCheckoutToggled  -> _state.update {
                it.copy(isGuestCheckout = event.isGuest, patientId = "", patientName = "")
            }
            is PosEvent.PatientChanged        -> _state.update {
                it.copy(patientId = event.id, patientName = event.name)
            }
            is PosEvent.SubmitSale            -> onSubmitSale()
            is PosEvent.DismissReceipt        -> onDismissReceipt()
        }
    }

    // ─── Private handlers ─────────────────────────────────────────────────────

    private fun onOpenShift(registerId: String, openingFloat: String) {
        val float = openingFloat.toDoubleOrNull() ?: 0.0
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = repository.openShift(registerId, float)) {
                is WResult.Success -> _state.update {
                    it.copy(isLoading = false, shiftOpen = true, registerId = registerId)
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to open shift"
                    _state.update { it.copy(isLoading = false, error = msg) }
                    _effects.send(PosEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onCloseShift(closingAmount: String) {
        val amount = closingAmount.toDoubleOrNull() ?: 0.0
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = repository.closeShift(amount, "")) {
                is WResult.Success -> _state.update {
                    PosUiState()  // full reset
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to close shift"
                    _state.update { it.copy(isLoading = false, error = msg) }
                    _effects.send(PosEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onItemFormChanged(field: String, value: String) {
        _state.update { current ->
            val form = when (field) {
                "lineType"     -> current.currentItemForm.copy(lineType = value)
                "name"         -> current.currentItemForm.copy(name = value)
                "qty"          -> current.currentItemForm.copy(qty = value)
                "unitPrice"    -> current.currentItemForm.copy(unitPrice = value)
                "lineDiscount" -> current.currentItemForm.copy(lineDiscount = value)
                else           -> current.currentItemForm
            }
            current.copy(currentItemForm = form)
        }
    }

    private fun onAddLineItem() {
        val form = _state.value.currentItemForm
        val name       = form.name.trim()
        val qty        = form.qty.toIntOrNull() ?: 0
        val unitPrice  = form.unitPrice.toDoubleOrNull() ?: 0.0
        val discount   = form.lineDiscount.toDoubleOrNull() ?: 0.0

        if (name.isBlank() || qty <= 0 || unitPrice <= 0.0) {
            viewModelScope.launch {
                _effects.send(PosEffect.ShowSnackbar("Enter item name, qty > 0 and unit price > 0"))
            }
            return
        }

        val item = PosLineItem(
            lineType     = form.lineType,
            name         = name,
            qty          = qty,
            unitPrice    = unitPrice,
            lineDiscount = discount,
        )

        _state.update { current ->
            val updated = current.lineItems + item
            current.copy(
                lineItems         = updated,
                currentItemForm   = PosItemForm(),
            ).recalcFinal()
        }
    }

    private fun onRemoveLineItem(index: Int) {
        _state.update { current ->
            val updated = current.lineItems.toMutableList().also { it.removeAt(index) }
            current.copy(lineItems = updated).recalcFinal()
        }
    }

    private fun onDiscountChanged(type: String, value: String) {
        _state.update { current ->
            current.copy(discountType = type, discountValue = value).recalcFinal()
        }
    }

    private fun onSubmitSale() {
        val state = _state.value
        if (state.lineItems.isEmpty()) {
            viewModelScope.launch {
                _effects.send(PosEffect.ShowSnackbar("Add at least one item before completing the sale"))
            }
            return
        }

        val request = PosSubmitRequest(
            patientId     = state.patientId.ifBlank { null },
            lineItems     = state.lineItems,
            paymentMethod = state.paymentMethod,
            discountTotal = state.discountAmount,
            finalAmount   = state.finalAmount,
            notes         = "",
        )

        viewModelScope.launch {
            _state.update { it.copy(isSubmitting = true, error = null) }
            when (val result = repository.submitSale(request)) {
                is WResult.Success -> {
                    _state.update { current ->
                        current.copy(
                            isSubmitting  = false,
                            lastReceipt   = result.data,
                            lineItems     = emptyList(),
                            discountType  = "none",
                            discountValue = "",
                            patientId     = "",
                            patientName   = "",
                            finalAmount   = 0.0,
                        )
                    }
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Sale failed"
                    _state.update { it.copy(isSubmitting = false, error = msg) }
                    _effects.send(PosEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onDismissReceipt() {
        _state.update { it.copy(lastReceipt = null) }
    }

    // ─── Calculation helper ───────────────────────────────────────────────────

    /**
     * Returns a copy of [this] with [PosUiState.finalAmount] recomputed from the
     * current [PosUiState.lineItems] and discount settings.  Must be called after
     * any mutation that affects the total.
     */
    private fun PosUiState.recalcFinal(): PosUiState {
        val final = (subtotal - discountAmount).coerceAtLeast(0.0)
        return copy(finalAmount = final)
    }
}

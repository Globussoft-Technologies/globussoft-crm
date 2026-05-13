package com.globussoft.wellness.feature.finance.presentation.coupons

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.finance.domain.model.Coupon
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

@HiltViewModel
class CouponsViewModel @Inject constructor(
    private val repository: FinanceRepository,
) : ViewModel() {

    private val _state   = MutableStateFlow(CouponsUiState())
    val state: StateFlow<CouponsUiState> = _state.asStateFlow()

    private val _effects = Channel<CouponsEffect>(Channel.BUFFERED)
    val effects: Flow<CouponsEffect> = _effects.receiveAsFlow()

    init { loadCoupons() }

    fun onEvent(event: CouponsEvent) {
        when (event) {
            is CouponsEvent.Refresh              -> loadCoupons()
            is CouponsEvent.ShowNewForm          -> _state.update { it.copy(showFormSheet = true, editingCoupon = null, formState = CouponFormState()) }
            is CouponsEvent.ShowEditForm         -> onShowEditForm(event.coupon)
            is CouponsEvent.DismissForm          -> _state.update { it.copy(showFormSheet = false) }
            is CouponsEvent.FormFieldChanged     -> onFormFieldChanged(event.field, event.value)
            is CouponsEvent.ActiveToggled        -> _state.update { it.copy(formState = it.formState.copy(isActive = event.isActive)) }
            is CouponsEvent.SubmitForm           -> onSubmitForm()
            is CouponsEvent.ShowPreviewDialog    -> _state.update { it.copy(showPreviewDialog = true, previewCode = "", previewAmount = "", previewResult = null) }
            is CouponsEvent.DismissPreviewDialog -> _state.update { it.copy(showPreviewDialog = false) }
            is CouponsEvent.PreviewFieldChanged  -> onPreviewFieldChanged(event.field, event.value)
            is CouponsEvent.SubmitPreview        -> onSubmitPreview()
            is CouponsEvent.RequestDelete        -> _state.update { it.copy(deleteTargetId = event.id) }
            is CouponsEvent.ConfirmDelete        -> onConfirmDelete()
            is CouponsEvent.DismissDelete        -> _state.update { it.copy(deleteTargetId = null) }
        }
    }

    // ─── Private handlers ─────────────────────────────────────────────────────

    private fun loadCoupons() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = repository.getCoupons()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, coupons = result.data) }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to load coupons"
                    _state.update { it.copy(isLoading = false, error = msg) }
                    _effects.send(CouponsEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onShowEditForm(coupon: Coupon) {
        _state.update {
            it.copy(
                showFormSheet  = true,
                editingCoupon  = coupon,
                formState      = CouponFormState(
                    code           = coupon.code,
                    discountType   = coupon.discountType,
                    amount         = coupon.amount.toString(),
                    minOrderAmount = coupon.minOrderAmount?.toString() ?: "",
                    maxRedemptions = coupon.maxRedemptions?.toString() ?: "",
                    expiryDate     = coupon.expiryDate ?: "",
                    isActive       = coupon.isActive,
                ),
            )
        }
    }

    private fun onFormFieldChanged(field: String, value: String) {
        _state.update { current ->
            val form = when (field) {
                "code"           -> current.formState.copy(code = value, codeError = null)
                "discountType"   -> current.formState.copy(discountType = value)
                "amount"         -> current.formState.copy(amount = value, amountError = null)
                "minOrderAmount" -> current.formState.copy(minOrderAmount = value)
                "maxRedemptions" -> current.formState.copy(maxRedemptions = value)
                "expiryDate"     -> current.formState.copy(expiryDate = value)
                else             -> current.formState
            }
            current.copy(formState = form)
        }
    }

    private fun onPreviewFieldChanged(field: String, value: String) {
        when (field) {
            "code"   -> _state.update { it.copy(previewCode = value, previewResult = null) }
            "amount" -> _state.update { it.copy(previewAmount = value, previewResult = null) }
        }
    }

    private fun onSubmitForm() {
        val form = _state.value.formState
        val codeError   = if (form.code.isBlank()) "Code is required" else null
        val amountError = if ((form.amount.toDoubleOrNull() ?: 0.0) <= 0.0) "Enter a valid discount amount" else null

        if (codeError != null || amountError != null) {
            _state.update { it.copy(formState = it.formState.copy(codeError = codeError, amountError = amountError)) }
            return
        }

        val params: Map<String, Any> = buildMap {
            put("code",         form.code.trim().uppercase())
            put("discountType", form.discountType)
            put("amount",       form.amount.toDouble())
            put("isActive",     form.isActive)
            if (form.minOrderAmount.isNotBlank()) put("minOrderAmount", form.minOrderAmount.toDouble())
            if (form.maxRedemptions.isNotBlank()) put("maxRedemptions", form.maxRedemptions.toInt())
            if (form.expiryDate.isNotBlank())     put("expiryDate", form.expiryDate)
        }

        val editingId = _state.value.editingCoupon?.id

        viewModelScope.launch {
            _state.update { it.copy(isSaving = true) }
            val result = if (editingId != null) {
                repository.updateCoupon(editingId, params)
            } else {
                repository.createCoupon(params)
            }
            when (result) {
                is WResult.Success -> {
                    val verb = if (editingId != null) "updated" else "created"
                    _state.update { current ->
                        val updated = if (editingId != null) {
                            current.coupons.map { if (it.id == editingId) result.data else it }
                        } else {
                            listOf(result.data) + current.coupons
                        }
                        current.copy(isSaving = false, showFormSheet = false, coupons = updated)
                    }
                    _effects.send(CouponsEffect.ShowSnackbar("Coupon $verb successfully"))
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to save coupon"
                    _state.update { it.copy(isSaving = false) }
                    _effects.send(CouponsEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onSubmitPreview() {
        val code   = _state.value.previewCode.trim()
        val amount = _state.value.previewAmount.toDoubleOrNull()
        if (code.isBlank() || amount == null || amount <= 0.0) {
            viewModelScope.launch { _effects.send(CouponsEffect.ShowSnackbar("Enter a valid code and amount")) }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(isPreviewing = true, previewResult = null) }
            when (val result = repository.previewCoupon(code, amount)) {
                is WResult.Success -> _state.update { it.copy(isPreviewing = false, previewResult = result.data) }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Preview failed"
                    _state.update { it.copy(isPreviewing = false) }
                    _effects.send(CouponsEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onConfirmDelete() {
        val id = _state.value.deleteTargetId ?: return
        viewModelScope.launch {
            _state.update { it.copy(isDeleting = true) }
            when (val result = repository.deleteCoupon(id)) {
                is WResult.Success -> {
                    _state.update { current ->
                        current.copy(
                            isDeleting     = false,
                            deleteTargetId = null,
                            coupons        = current.coupons.filter { it.id != id },
                        )
                    }
                    _effects.send(CouponsEffect.ShowSnackbar("Coupon deleted"))
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to delete coupon"
                    _state.update { it.copy(isDeleting = false, deleteTargetId = null) }
                    _effects.send(CouponsEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }
}

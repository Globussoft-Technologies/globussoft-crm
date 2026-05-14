package com.globussoft.wellness.feature.admin.presentation.autoconsumption

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.AutoConsumptionRuleItem
import com.globussoft.wellness.feature.admin.domain.repository.ProductItem
import com.globussoft.wellness.feature.admin.domain.repository.ServiceItem
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

data class AutoConsumptionUiState(
    val isLoading: Boolean = false,
    val rules: List<AutoConsumptionRuleItem> = emptyList(),
    val services: List<ServiceItem> = emptyList(),
    val products: List<ProductItem> = emptyList(),
    val error: String? = null,
    val showSheet: Boolean = false,
    val editingItem: AutoConsumptionRuleItem? = null,
    val form: AutoConsumptionForm = AutoConsumptionForm(),
    val isSaving: Boolean = false,
    val saveError: String? = null,
    val showDeleteConfirm: Boolean = false,
    val deletingId: String? = null,
)

data class AutoConsumptionForm(
    val serviceId: String = "",
    val productId: String = "",
    val quantityPerVisit: String = "1",
    val isActive: Boolean = true,
)

sealed class AutoConsumptionEvent {
    data object OpenNewSheet : AutoConsumptionEvent()
    data class OpenEditSheet(val item: AutoConsumptionRuleItem) : AutoConsumptionEvent()
    data class SelectService(val id: String) : AutoConsumptionEvent()
    data class SelectProduct(val id: String) : AutoConsumptionEvent()
    data class FieldChanged(val field: String, val value: String) : AutoConsumptionEvent()
    data class ToggleActive(val value: Boolean) : AutoConsumptionEvent()
    data object Save : AutoConsumptionEvent()
    data object DismissSheet : AutoConsumptionEvent()
    data class RequestDelete(val id: String) : AutoConsumptionEvent()
    data object ConfirmDelete : AutoConsumptionEvent()
    data object DismissDelete : AutoConsumptionEvent()
    data object Refresh : AutoConsumptionEvent()
}

sealed class AutoConsumptionEffect {
    data class ShowSnackbar(val message: String) : AutoConsumptionEffect()
}

@HiltViewModel
class AutoConsumptionViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(AutoConsumptionUiState())
    val state: StateFlow<AutoConsumptionUiState> = _state.asStateFlow()

    private val _effects = Channel<AutoConsumptionEffect>(Channel.BUFFERED)
    val effects: Flow<AutoConsumptionEffect> = _effects.receiveAsFlow()

    init { load() }

    fun onEvent(event: AutoConsumptionEvent) {
        when (event) {
            AutoConsumptionEvent.OpenNewSheet -> _state.update {
                it.copy(showSheet = true, editingItem = null, form = AutoConsumptionForm(), saveError = null)
            }
            is AutoConsumptionEvent.OpenEditSheet -> _state.update {
                it.copy(
                    showSheet = true, editingItem = event.item, saveError = null,
                    form = AutoConsumptionForm(
                        serviceId        = event.item.serviceId,
                        productId        = event.item.productId,
                        quantityPerVisit = event.item.quantityPerVisit.toString(),
                        isActive         = event.item.isActive,
                    ),
                )
            }
            is AutoConsumptionEvent.SelectService -> _state.update {
                it.copy(form = it.form.copy(serviceId = event.id))
            }
            is AutoConsumptionEvent.SelectProduct -> _state.update {
                it.copy(form = it.form.copy(productId = event.id))
            }
            is AutoConsumptionEvent.FieldChanged -> _state.update { s ->
                s.copy(form = when (event.field) {
                    "quantityPerVisit" -> s.form.copy(quantityPerVisit = event.value)
                    else               -> s.form
                })
            }
            is AutoConsumptionEvent.ToggleActive -> _state.update {
                it.copy(form = it.form.copy(isActive = event.value))
            }
            AutoConsumptionEvent.Save -> save()
            AutoConsumptionEvent.DismissSheet -> _state.update {
                it.copy(showSheet = false, editingItem = null, form = AutoConsumptionForm(), saveError = null)
            }
            is AutoConsumptionEvent.RequestDelete -> _state.update {
                it.copy(showDeleteConfirm = true, deletingId = event.id)
            }
            AutoConsumptionEvent.ConfirmDelete -> delete()
            AutoConsumptionEvent.DismissDelete -> _state.update {
                it.copy(showDeleteConfirm = false, deletingId = null)
            }
            AutoConsumptionEvent.Refresh -> load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getAutoConsumptionRules()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, rules = r.data) }
                is WResult.Error   -> _state.update { it.copy(isLoading = false, error = r.message ?: r.exception.message ?: "Failed to load") }
                WResult.Loading    -> Unit
            }
            // Load pickers in background
            val sr = repository.getServicesForPicker()
            if (sr is WResult.Success) _state.update { it.copy(services = sr.data) }
            val pr = repository.getProducts()
            if (pr is WResult.Success) _state.update { it.copy(products = pr.data) }
        }
    }

    private fun save() {
        val form = _state.value.form
        if (form.serviceId.isBlank()) { _state.update { it.copy(saveError = "Service is required") }; return }
        if (form.productId.isBlank()) { _state.update { it.copy(saveError = "Product is required") }; return }
        val qty = form.quantityPerVisit.toDoubleOrNull()
        if (qty == null || qty <= 0) { _state.update { it.copy(saveError = "Quantity must be > 0") }; return }
        val params = buildMap<String, Any> {
            put("serviceId", form.serviceId)
            put("productId", form.productId)
            put("quantityPerVisit", qty)
            put("isActive", form.isActive)
        }
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true, saveError = null) }
            val editingId = _state.value.editingItem?.id
            val result = if (editingId != null) repository.updateAutoConsumptionRule(editingId, params)
                         else repository.createAutoConsumptionRule(params)
            when (result) {
                is WResult.Success -> {
                    _state.update { it.copy(isSaving = false, showSheet = false, editingItem = null, form = AutoConsumptionForm()) }
                    _effects.send(AutoConsumptionEffect.ShowSnackbar(
                        if (editingId != null) "Rule updated" else "Rule created"
                    ))
                    load()
                }
                is WResult.Error -> _state.update {
                    it.copy(isSaving = false, saveError = result.message ?: result.exception.message ?: "Save failed")
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun delete() {
        val id = _state.value.deletingId ?: return
        viewModelScope.launch {
            _state.update { it.copy(showDeleteConfirm = false, deletingId = null) }
            when (val r = repository.deleteAutoConsumptionRule(id)) {
                is WResult.Success -> { _effects.send(AutoConsumptionEffect.ShowSnackbar("Rule deleted")); load() }
                is WResult.Error   -> _effects.send(AutoConsumptionEffect.ShowSnackbar(r.message ?: r.exception.message ?: "Delete failed"))
                WResult.Loading    -> Unit
            }
        }
    }
}

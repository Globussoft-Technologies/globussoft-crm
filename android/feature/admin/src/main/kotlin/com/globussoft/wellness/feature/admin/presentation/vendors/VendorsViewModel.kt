package com.globussoft.wellness.feature.admin.presentation.vendors

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.VendorItem
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

data class VendorsUiState(
    val isLoading: Boolean = false,
    val vendors: List<VendorItem> = emptyList(),
    val error: String? = null,
    val showSheet: Boolean = false,
    val editingItem: VendorItem? = null,
    val form: VendorForm = VendorForm(),
    val isSaving: Boolean = false,
    val saveError: String? = null,
    val showDeleteConfirm: Boolean = false,
    val deletingId: String? = null,
)

data class VendorForm(
    val name: String = "",
    val contactPerson: String = "",
    val phone: String = "",
    val email: String = "",
    val gstin: String = "",
)

sealed class VendorsEvent {
    data object OpenNewSheet : VendorsEvent()
    data class OpenEditSheet(val item: VendorItem) : VendorsEvent()
    data class FieldChanged(val field: String, val value: String) : VendorsEvent()
    data object Save : VendorsEvent()
    data object DismissSheet : VendorsEvent()
    data class RequestDelete(val id: String) : VendorsEvent()
    data object ConfirmDelete : VendorsEvent()
    data object DismissDelete : VendorsEvent()
    data object Refresh : VendorsEvent()
}

sealed class VendorsEffect {
    data class ShowSnackbar(val message: String) : VendorsEffect()
}

@HiltViewModel
class VendorsViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(VendorsUiState())
    val state: StateFlow<VendorsUiState> = _state.asStateFlow()

    private val _effects = Channel<VendorsEffect>(Channel.BUFFERED)
    val effects: Flow<VendorsEffect> = _effects.receiveAsFlow()

    init { load() }

    fun onEvent(event: VendorsEvent) {
        when (event) {
            VendorsEvent.OpenNewSheet -> _state.update {
                it.copy(showSheet = true, editingItem = null, form = VendorForm(), saveError = null)
            }
            is VendorsEvent.OpenEditSheet -> _state.update {
                it.copy(
                    showSheet = true, editingItem = event.item, saveError = null,
                    form = VendorForm(
                        name          = event.item.name,
                        contactPerson = event.item.contactPerson ?: "",
                        phone         = event.item.phone ?: "",
                        email         = event.item.email ?: "",
                        gstin         = event.item.gstin ?: "",
                    ),
                )
            }
            is VendorsEvent.FieldChanged -> _state.update { s ->
                s.copy(form = when (event.field) {
                    "name"          -> s.form.copy(name = event.value)
                    "contactPerson" -> s.form.copy(contactPerson = event.value)
                    "phone"         -> s.form.copy(phone = event.value)
                    "email"         -> s.form.copy(email = event.value)
                    "gstin"         -> s.form.copy(gstin = event.value)
                    else            -> s.form
                })
            }
            VendorsEvent.Save -> save()
            VendorsEvent.DismissSheet -> _state.update {
                it.copy(showSheet = false, editingItem = null, form = VendorForm(), saveError = null)
            }
            is VendorsEvent.RequestDelete -> _state.update {
                it.copy(showDeleteConfirm = true, deletingId = event.id)
            }
            VendorsEvent.ConfirmDelete -> delete()
            VendorsEvent.DismissDelete -> _state.update {
                it.copy(showDeleteConfirm = false, deletingId = null)
            }
            VendorsEvent.Refresh -> load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getVendors()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, vendors = r.data) }
                is WResult.Error   -> _state.update { it.copy(isLoading = false, error = r.message ?: r.exception.message ?: "Failed to load") }
                WResult.Loading    -> Unit
            }
        }
    }

    private fun save() {
        val form = _state.value.form
        if (form.name.isBlank()) { _state.update { it.copy(saveError = "Vendor name is required") }; return }
        val params = buildMap<String, Any> {
            put("name", form.name.trim())
            if (form.contactPerson.isNotBlank()) put("contactPerson", form.contactPerson.trim())
            if (form.phone.isNotBlank())         put("phone", form.phone.trim())
            if (form.email.isNotBlank())         put("email", form.email.trim())
            if (form.gstin.isNotBlank())         put("gstin", form.gstin.trim())
        }
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true, saveError = null) }
            val editingId = _state.value.editingItem?.id
            val result = if (editingId != null) repository.updateVendor(editingId, params)
                         else repository.createVendor(params)
            when (result) {
                is WResult.Success -> {
                    _state.update { it.copy(isSaving = false, showSheet = false, editingItem = null, form = VendorForm()) }
                    _effects.send(VendorsEffect.ShowSnackbar(if (editingId != null) "Vendor updated" else "Vendor added"))
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
            when (val r = repository.deleteVendor(id)) {
                is WResult.Success -> { _effects.send(VendorsEffect.ShowSnackbar("Vendor deleted")); load() }
                is WResult.Error   -> _effects.send(VendorsEffect.ShowSnackbar(r.message ?: r.exception.message ?: "Delete failed"))
                WResult.Loading    -> Unit
            }
        }
    }
}

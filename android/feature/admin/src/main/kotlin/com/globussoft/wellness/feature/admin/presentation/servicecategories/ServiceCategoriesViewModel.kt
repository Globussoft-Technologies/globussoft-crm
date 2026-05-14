package com.globussoft.wellness.feature.admin.presentation.servicecategories

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.ServiceCategoryItem
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

data class ServiceCategoriesUiState(
    val isLoading: Boolean = false,
    val categories: List<ServiceCategoryItem> = emptyList(),
    val error: String? = null,
    val showSheet: Boolean = false,
    val editingItem: ServiceCategoryItem? = null,
    val form: ServiceCategoryForm = ServiceCategoryForm(),
    val isSaving: Boolean = false,
    val saveError: String? = null,
    val showDeleteConfirm: Boolean = false,
    val deletingId: String? = null,
)

data class ServiceCategoryForm(
    val name: String = "",
    val displayOrder: String = "0",
    val isActive: Boolean = true,
)

sealed class ServiceCategoriesEvent {
    data object OpenNewSheet : ServiceCategoriesEvent()
    data class OpenEditSheet(val item: ServiceCategoryItem) : ServiceCategoriesEvent()
    data class FieldChanged(val field: String, val value: String) : ServiceCategoriesEvent()
    data class ToggleActive(val value: Boolean) : ServiceCategoriesEvent()
    data object Save : ServiceCategoriesEvent()
    data object DismissSheet : ServiceCategoriesEvent()
    data class RequestDelete(val id: String) : ServiceCategoriesEvent()
    data object ConfirmDelete : ServiceCategoriesEvent()
    data object DismissDelete : ServiceCategoriesEvent()
    data object Refresh : ServiceCategoriesEvent()
}

sealed class ServiceCategoriesEffect {
    data class ShowSnackbar(val message: String) : ServiceCategoriesEffect()
}

@HiltViewModel
class ServiceCategoriesViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ServiceCategoriesUiState())
    val state: StateFlow<ServiceCategoriesUiState> = _state.asStateFlow()

    private val _effects = Channel<ServiceCategoriesEffect>(Channel.BUFFERED)
    val effects: Flow<ServiceCategoriesEffect> = _effects.receiveAsFlow()

    init { load() }

    fun onEvent(event: ServiceCategoriesEvent) {
        when (event) {
            ServiceCategoriesEvent.OpenNewSheet -> _state.update {
                it.copy(showSheet = true, editingItem = null, form = ServiceCategoryForm(), saveError = null)
            }
            is ServiceCategoriesEvent.OpenEditSheet -> _state.update {
                it.copy(
                    showSheet = true, editingItem = event.item, saveError = null,
                    form = ServiceCategoryForm(
                        name         = event.item.name,
                        displayOrder = event.item.displayOrder.toString(),
                        isActive     = event.item.isActive,
                    ),
                )
            }
            is ServiceCategoriesEvent.FieldChanged -> _state.update { s ->
                s.copy(form = when (event.field) {
                    "name"         -> s.form.copy(name = event.value)
                    "displayOrder" -> s.form.copy(displayOrder = event.value)
                    else           -> s.form
                })
            }
            is ServiceCategoriesEvent.ToggleActive -> _state.update {
                it.copy(form = it.form.copy(isActive = event.value))
            }
            ServiceCategoriesEvent.Save -> save()
            ServiceCategoriesEvent.DismissSheet -> _state.update {
                it.copy(showSheet = false, editingItem = null, form = ServiceCategoryForm(), saveError = null)
            }
            is ServiceCategoriesEvent.RequestDelete -> _state.update {
                it.copy(showDeleteConfirm = true, deletingId = event.id)
            }
            ServiceCategoriesEvent.ConfirmDelete -> delete()
            ServiceCategoriesEvent.DismissDelete -> _state.update {
                it.copy(showDeleteConfirm = false, deletingId = null)
            }
            ServiceCategoriesEvent.Refresh -> load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getServiceCategories()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, categories = r.data) }
                is WResult.Error   -> _state.update { it.copy(isLoading = false, error = r.message ?: r.exception.message ?: "Failed to load") }
                WResult.Loading    -> Unit
            }
        }
    }

    private fun save() {
        val form = _state.value.form
        if (form.name.isBlank()) { _state.update { it.copy(saveError = "Name is required") }; return }
        val params = buildMap<String, Any> {
            put("name", form.name.trim())
            put("displayOrder", form.displayOrder.toIntOrNull() ?: 0)
            put("isActive", form.isActive)
        }
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true, saveError = null) }
            val editingId = _state.value.editingItem?.id
            val result = if (editingId != null) repository.updateServiceCategory(editingId, params)
                         else repository.createServiceCategory(params)
            when (result) {
                is WResult.Success -> {
                    _state.update { it.copy(isSaving = false, showSheet = false, editingItem = null, form = ServiceCategoryForm()) }
                    _effects.send(ServiceCategoriesEffect.ShowSnackbar(
                        if (editingId != null) "Category updated" else "Category created"
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
            when (val r = repository.deleteServiceCategory(id)) {
                is WResult.Success -> { _effects.send(ServiceCategoriesEffect.ShowSnackbar("Category deleted")); load() }
                is WResult.Error   -> _effects.send(ServiceCategoriesEffect.ShowSnackbar(r.message ?: r.exception.message ?: "Delete failed"))
                WResult.Loading    -> Unit
            }
        }
    }
}

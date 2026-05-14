package com.globussoft.wellness.feature.admin.presentation.productcategories

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.ProductCategoryItem
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

data class ProductCategoriesUiState(
    val isLoading: Boolean = false,
    val categories: List<ProductCategoryItem> = emptyList(),
    val error: String? = null,
    val showSheet: Boolean = false,
    val editingItem: ProductCategoryItem? = null,
    val form: ProductCategoryForm = ProductCategoryForm(),
    val isSaving: Boolean = false,
    val saveError: String? = null,
    val showDeleteConfirm: Boolean = false,
    val deletingId: String? = null,
)

data class ProductCategoryForm(
    val name: String = "",
    val isActive: Boolean = true,
)

sealed class ProductCategoriesEvent {
    data object OpenNewSheet : ProductCategoriesEvent()
    data class OpenEditSheet(val item: ProductCategoryItem) : ProductCategoriesEvent()
    data class FieldChanged(val field: String, val value: String) : ProductCategoriesEvent()
    data class ToggleActive(val value: Boolean) : ProductCategoriesEvent()
    data object Save : ProductCategoriesEvent()
    data object DismissSheet : ProductCategoriesEvent()
    data class RequestDelete(val id: String) : ProductCategoriesEvent()
    data object ConfirmDelete : ProductCategoriesEvent()
    data object DismissDelete : ProductCategoriesEvent()
    data object Refresh : ProductCategoriesEvent()
}

sealed class ProductCategoriesEffect {
    data class ShowSnackbar(val message: String) : ProductCategoriesEffect()
}

@HiltViewModel
class ProductCategoriesViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ProductCategoriesUiState())
    val state: StateFlow<ProductCategoriesUiState> = _state.asStateFlow()

    private val _effects = Channel<ProductCategoriesEffect>(Channel.BUFFERED)
    val effects: Flow<ProductCategoriesEffect> = _effects.receiveAsFlow()

    init { load() }

    fun onEvent(event: ProductCategoriesEvent) {
        when (event) {
            ProductCategoriesEvent.OpenNewSheet -> _state.update {
                it.copy(showSheet = true, editingItem = null, form = ProductCategoryForm(), saveError = null)
            }
            is ProductCategoriesEvent.OpenEditSheet -> _state.update {
                it.copy(
                    showSheet = true, editingItem = event.item, saveError = null,
                    form = ProductCategoryForm(name = event.item.name, isActive = event.item.isActive),
                )
            }
            is ProductCategoriesEvent.FieldChanged -> _state.update { s ->
                s.copy(form = when (event.field) {
                    "name" -> s.form.copy(name = event.value)
                    else   -> s.form
                })
            }
            is ProductCategoriesEvent.ToggleActive -> _state.update {
                it.copy(form = it.form.copy(isActive = event.value))
            }
            ProductCategoriesEvent.Save -> save()
            ProductCategoriesEvent.DismissSheet -> _state.update {
                it.copy(showSheet = false, editingItem = null, form = ProductCategoryForm(), saveError = null)
            }
            is ProductCategoriesEvent.RequestDelete -> _state.update {
                it.copy(showDeleteConfirm = true, deletingId = event.id)
            }
            ProductCategoriesEvent.ConfirmDelete -> delete()
            ProductCategoriesEvent.DismissDelete -> _state.update {
                it.copy(showDeleteConfirm = false, deletingId = null)
            }
            ProductCategoriesEvent.Refresh -> load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getProductCategories()) {
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
            put("isActive", form.isActive)
        }
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true, saveError = null) }
            val editingId = _state.value.editingItem?.id
            val result = if (editingId != null) repository.updateProductCategory(editingId, params)
                         else repository.createProductCategory(params)
            when (result) {
                is WResult.Success -> {
                    _state.update { it.copy(isSaving = false, showSheet = false, editingItem = null, form = ProductCategoryForm()) }
                    _effects.send(ProductCategoriesEffect.ShowSnackbar(
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
            when (val r = repository.deleteProductCategory(id)) {
                is WResult.Success -> { _effects.send(ProductCategoriesEffect.ShowSnackbar("Category deleted")); load() }
                is WResult.Error   -> _effects.send(ProductCategoriesEffect.ShowSnackbar(r.message ?: r.exception.message ?: "Delete failed"))
                WResult.Loading    -> Unit
            }
        }
    }
}

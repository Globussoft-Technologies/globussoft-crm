package com.globussoft.wellness.feature.admin.presentation.drugs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.DrugItem
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

// ─── UiState ──────────────────────────────────────────────────────────────────

/**
 * Immutable UI state for the Drug Catalogue CRUD screen.
 */
data class DrugsUiState(
    val isLoading: Boolean = false,
    val drugs: List<DrugItem> = emptyList(),
    val error: String? = null,
    val showSheet: Boolean = false,
    val editingDrug: DrugItem? = null,
    val form: DrugFormState = DrugFormState(),
    val isSaving: Boolean = false,
    val saveError: String? = null,
    val showDeleteConfirm: Boolean = false,
    val deletingId: String? = null,
)

data class DrugFormState(
    val name: String = "",
    val dosageForm: String = "",
    val strength: String = "",
    val unit: String = "",
    val category: String = "",
    val sideEffects: String = "",
    val contraindications: String = "",
)

val DOSAGE_FORMS = listOf("Tablet", "Capsule", "Syrup", "Injection", "Cream", "Drops", "Other")

sealed class DrugsEvent {
    data object OpenNewSheet : DrugsEvent()
    data class OpenEditSheet(val drug: DrugItem) : DrugsEvent()
    data class FieldChanged(val field: String, val value: String) : DrugsEvent()
    data object Save : DrugsEvent()
    data object DismissSheet : DrugsEvent()
    data class RequestDelete(val id: String) : DrugsEvent()
    data object ConfirmDelete : DrugsEvent()
    data object DismissDelete : DrugsEvent()
    data object Refresh : DrugsEvent()
}

sealed class DrugsEffect {
    data class ShowSnackbar(val message: String) : DrugsEffect()
}

// ─── ViewModel ────────────────────────────────────────────────────────────────

/**
 * ViewModel for the Drug Catalogue CRUD screen.
 */
@HiltViewModel
class DrugsViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(DrugsUiState())
    val state: StateFlow<DrugsUiState> = _state.asStateFlow()

    private val _effects = Channel<DrugsEffect>(Channel.BUFFERED)
    val effects: Flow<DrugsEffect> = _effects.receiveAsFlow()

    init { load() }

    fun onEvent(event: DrugsEvent) {
        when (event) {
            DrugsEvent.OpenNewSheet        -> openNewSheet()
            is DrugsEvent.OpenEditSheet    -> openEditSheet(event.drug)
            is DrugsEvent.FieldChanged     -> onFieldChanged(event.field, event.value)
            DrugsEvent.Save                -> save()
            DrugsEvent.DismissSheet        -> _state.update { it.copy(showSheet = false, editingDrug = null, form = DrugFormState(), saveError = null) }
            is DrugsEvent.RequestDelete    -> _state.update { it.copy(showDeleteConfirm = true, deletingId = event.id) }
            DrugsEvent.ConfirmDelete       -> delete()
            DrugsEvent.DismissDelete       -> _state.update { it.copy(showDeleteConfirm = false, deletingId = null) }
            DrugsEvent.Refresh             -> load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getDrugs()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, drugs = r.data) }
                is WResult.Error   -> {
                    val msg = r.message ?: r.exception.message ?: "Failed to load drugs"
                    _state.update { it.copy(isLoading = false, error = msg) }
                }
                WResult.Loading    -> Unit
            }
        }
    }

    private fun openNewSheet() {
        _state.update { it.copy(showSheet = true, editingDrug = null, form = DrugFormState(), saveError = null) }
    }

    private fun openEditSheet(drug: DrugItem) {
        _state.update { it.copy(
            showSheet   = true,
            editingDrug = drug,
            saveError   = null,
            form = DrugFormState(
                name             = drug.name,
                dosageForm       = drug.dosageForm ?: "",
                strength         = drug.strength ?: "",
                unit             = drug.unit ?: "",
                category         = drug.category ?: "",
                sideEffects      = drug.sideEffects ?: "",
                contraindications = drug.contraindications ?: "",
            ),
        ) }
    }

    private fun onFieldChanged(field: String, value: String) {
        _state.update { s ->
            s.copy(
                form = when (field) {
                    "name"             -> s.form.copy(name = value)
                    "dosageForm"       -> s.form.copy(dosageForm = value)
                    "strength"         -> s.form.copy(strength = value)
                    "unit"             -> s.form.copy(unit = value)
                    "category"         -> s.form.copy(category = value)
                    "sideEffects"      -> s.form.copy(sideEffects = value)
                    "contraindications" -> s.form.copy(contraindications = value)
                    else               -> s.form
                },
            )
        }
    }

    private fun save() {
        val form = _state.value.form
        if (form.name.isBlank()) {
            _state.update { it.copy(saveError = "Drug name is required") }
            return
        }
        val params = buildMap<String, Any> {
            put("name", form.name.trim())
            if (form.dosageForm.isNotBlank())       put("dosageForm", form.dosageForm)
            if (form.strength.isNotBlank())         put("strength", form.strength.trim())
            if (form.unit.isNotBlank())             put("unit", form.unit.trim())
            if (form.category.isNotBlank())         put("category", form.category.trim())
            if (form.sideEffects.isNotBlank())      put("sideEffects", form.sideEffects.trim())
            if (form.contraindications.isNotBlank()) put("contraindications", form.contraindications.trim())
        }

        viewModelScope.launch {
            _state.update { it.copy(isSaving = true, saveError = null) }
            val editingId = _state.value.editingDrug?.id
            val result = if (editingId != null) {
                repository.updateDrug(editingId, params)
            } else {
                repository.createDrug(params)
            }
            when (result) {
                is WResult.Success -> {
                    _state.update { it.copy(isSaving = false, showSheet = false, editingDrug = null, form = DrugFormState()) }
                    _effects.send(DrugsEffect.ShowSnackbar(
                        if (editingId != null) "Drug updated" else "Drug added to catalogue",
                    ))
                    load()
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Save failed"
                    _state.update { it.copy(isSaving = false, saveError = msg) }
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun delete() {
        val id = _state.value.deletingId ?: return
        viewModelScope.launch {
            _state.update { it.copy(showDeleteConfirm = false, deletingId = null) }
            when (val r = repository.deleteDrug(id)) {
                is WResult.Success -> {
                    _effects.send(DrugsEffect.ShowSnackbar("Drug removed from catalogue"))
                    load()
                }
                is WResult.Error -> {
                    val msg = r.message ?: r.exception.message ?: "Delete failed"
                    _effects.send(DrugsEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }
}

package com.globussoft.wellness.feature.admin.presentation.cashbackrules

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.CashbackRuleItem
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

data class CashbackRulesUiState(
    val isLoading: Boolean = false,
    val rules: List<CashbackRuleItem> = emptyList(),
    val error: String? = null,
    val showSheet: Boolean = false,
    val editingItem: CashbackRuleItem? = null,
    val form: CashbackRuleForm = CashbackRuleForm(),
    val isSaving: Boolean = false,
    val saveError: String? = null,
    val showDeleteConfirm: Boolean = false,
    val deletingId: String? = null,
)

data class CashbackRuleForm(
    val name: String = "",
    val earnPercent: String = "",
    val minSpend: String = "",
    val isActive: Boolean = true,
)

sealed class CashbackRulesEvent {
    data object OpenNewSheet : CashbackRulesEvent()
    data class OpenEditSheet(val item: CashbackRuleItem) : CashbackRulesEvent()
    data class FieldChanged(val field: String, val value: String) : CashbackRulesEvent()
    data class ToggleActive(val value: Boolean) : CashbackRulesEvent()
    data object Save : CashbackRulesEvent()
    data object DismissSheet : CashbackRulesEvent()
    data class RequestDelete(val id: String) : CashbackRulesEvent()
    data object ConfirmDelete : CashbackRulesEvent()
    data object DismissDelete : CashbackRulesEvent()
    data object Refresh : CashbackRulesEvent()
}

sealed class CashbackRulesEffect {
    data class ShowSnackbar(val message: String) : CashbackRulesEffect()
}

@HiltViewModel
class CashbackRulesViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(CashbackRulesUiState())
    val state: StateFlow<CashbackRulesUiState> = _state.asStateFlow()

    private val _effects = Channel<CashbackRulesEffect>(Channel.BUFFERED)
    val effects: Flow<CashbackRulesEffect> = _effects.receiveAsFlow()

    init { load() }

    fun onEvent(event: CashbackRulesEvent) {
        when (event) {
            CashbackRulesEvent.OpenNewSheet -> _state.update {
                it.copy(showSheet = true, editingItem = null, form = CashbackRuleForm(), saveError = null)
            }
            is CashbackRulesEvent.OpenEditSheet -> _state.update {
                it.copy(
                    showSheet = true, editingItem = event.item, saveError = null,
                    form = CashbackRuleForm(
                        name        = event.item.name,
                        earnPercent = event.item.earnPercent.toString(),
                        minSpend    = event.item.minSpend?.toString() ?: "",
                        isActive    = event.item.isActive,
                    ),
                )
            }
            is CashbackRulesEvent.FieldChanged -> _state.update { s ->
                s.copy(form = when (event.field) {
                    "name"        -> s.form.copy(name = event.value)
                    "earnPercent" -> s.form.copy(earnPercent = event.value)
                    "minSpend"    -> s.form.copy(minSpend = event.value)
                    else          -> s.form
                })
            }
            is CashbackRulesEvent.ToggleActive -> _state.update {
                it.copy(form = it.form.copy(isActive = event.value))
            }
            CashbackRulesEvent.Save -> save()
            CashbackRulesEvent.DismissSheet -> _state.update {
                it.copy(showSheet = false, editingItem = null, form = CashbackRuleForm(), saveError = null)
            }
            is CashbackRulesEvent.RequestDelete -> _state.update {
                it.copy(showDeleteConfirm = true, deletingId = event.id)
            }
            CashbackRulesEvent.ConfirmDelete -> delete()
            CashbackRulesEvent.DismissDelete -> _state.update {
                it.copy(showDeleteConfirm = false, deletingId = null)
            }
            CashbackRulesEvent.Refresh -> load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repository.getCashbackRules()) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, rules = r.data) }
                is WResult.Error   -> _state.update { it.copy(isLoading = false, error = r.message ?: r.exception.message ?: "Failed to load") }
                WResult.Loading    -> Unit
            }
        }
    }

    private fun save() {
        val form = _state.value.form
        if (form.name.isBlank()) { _state.update { it.copy(saveError = "Name is required") }; return }
        val earnPct = form.earnPercent.toDoubleOrNull()
        if (earnPct == null) { _state.update { it.copy(saveError = "Earn % must be a number") }; return }
        val params = buildMap<String, Any> {
            put("name", form.name.trim())
            put("earnPercent", earnPct)
            put("isActive", form.isActive)
            val ms = form.minSpend.toDoubleOrNull()
            if (ms != null) put("minSpend", ms)
        }
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true, saveError = null) }
            val editingId = _state.value.editingItem?.id
            val result = if (editingId != null) repository.updateCashbackRule(editingId, params)
                         else repository.createCashbackRule(params)
            when (result) {
                is WResult.Success -> {
                    _state.update { it.copy(isSaving = false, showSheet = false, editingItem = null, form = CashbackRuleForm()) }
                    _effects.send(CashbackRulesEffect.ShowSnackbar(
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
            when (val r = repository.deleteCashbackRule(id)) {
                is WResult.Success -> { _effects.send(CashbackRulesEffect.ShowSnackbar("Rule deleted")); load() }
                is WResult.Error   -> _effects.send(CashbackRulesEffect.ShowSnackbar(r.message ?: r.exception.message ?: "Delete failed"))
                WResult.Loading    -> Unit
            }
        }
    }
}

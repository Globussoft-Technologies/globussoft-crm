package com.globussoft.wellness.feature.crm.presentation.deals

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Deal
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class DealsViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(DealsUiState())
    val state: StateFlow<DealsUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun setStage(stage: String?) {
        _state.update { it.copy(selectedStage = stage) }
        load()
    }

    fun setStatus(status: String?) {
        _state.update { it.copy(selectedStatus = status) }
        load()
    }

    fun refresh() = load()

    fun showAdd() = _state.update { it.copy(showAddForm = true, editingDeal = null) }
    fun showEdit(deal: Deal) = _state.update { it.copy(showAddForm = true, editingDeal = deal) }
    fun dismissForm() = _state.update { it.copy(showAddForm = false, editingDeal = null, formError = null) }

    fun saveDeal(title: String, amount: String, stage: String, probability: String) {
        viewModelScope.launch {
            val amt = amount.toDoubleOrNull() ?: 0.0
            val prob = probability.toIntOrNull() ?: 0
            _state.update { it.copy(isCreating = true, formError = null) }
            val editing = _state.value.editingDeal
            val result = if (editing != null) {
                repo.updateDeal(editing.id, mapOf("title" to title, "amount" to amt, "stage" to stage, "probability" to prob))
            } else {
                repo.createDeal(title, amt, stage, null, null, prob)
            }
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isCreating = false, showAddForm = false, editingDeal = null)
                    is WResult.Error   -> current.copy(isCreating = false, formError = result.message ?: result.exception.message)
                    WResult.Loading    -> current
                }
            }
            if (result is WResult.Success) load()
        }
    }

    fun confirmDelete(id: String) = _state.update { it.copy(deleteConfirmId = id) }
    fun cancelDelete() = _state.update { it.copy(deleteConfirmId = null) }

    fun deleteDeal(id: String) {
        viewModelScope.launch {
            _state.update { it.copy(deleteConfirmId = null) }
            repo.updateDeal(id, mapOf("status" to "DELETED"))
            load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = repo.getDeals(
                stage  = _state.value.selectedStage,
                status = _state.value.selectedStatus,
            )) {
                is WResult.Success -> {
                    _state.update { it.copy(isLoading = false, deals = result.data) }
                }
                is WResult.Error -> {
                    _state.update { it.copy(
                        isLoading = false,
                        error     = result.message ?: result.exception.message,
                    ) }
                }
                WResult.Loading -> Unit
            }
        }
    }
}

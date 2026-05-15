package com.globussoft.wellness.feature.crm.presentation.expenses

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ExpensesViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ExpensesUiState())
    val state: StateFlow<ExpensesUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun setCategory(category: String?) {
        _state.update { it.copy(selectedCategory = category) }
        load()
    }

    fun approve(id: String) {
        viewModelScope.launch {
            when (val result = repo.approveExpense(id)) {
                is WResult.Success -> load()
                is WResult.Error   -> _state.update {
                    it.copy(error = result.message ?: result.exception.message ?: "Failed to approve expense")
                }
                WResult.Loading    -> Unit
            }
        }
    }

    fun reject(id: String) {
        viewModelScope.launch {
            when (val result = repo.rejectExpense(id)) {
                is WResult.Success -> load()
                is WResult.Error   -> _state.update {
                    it.copy(error = result.message ?: result.exception.message ?: "Failed to reject expense")
                }
                WResult.Loading    -> Unit
            }
        }
    }

    fun refresh() = load()

    fun showCreate() = _state.update { it.copy(showCreateForm = true, formError = null) }
    fun dismissCreate() = _state.update { it.copy(showCreateForm = false, formError = null) }

    fun createExpense(title: String, amount: String, category: String, date: String, notes: String) {
        viewModelScope.launch {
            _state.update { it.copy(isCreating = true, formError = null) }
            val amountDouble = amount.toDoubleOrNull() ?: 0.0
            val result = repo.createExpense(
                title    = title,
                amount   = amountDouble,
                category = category.ifBlank { "Other" },
                date     = date.ifBlank { java.time.LocalDate.now().toString() },
                notes    = notes.ifBlank { null },
            )
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isCreating = false, showCreateForm = false)
                    is WResult.Error   -> current.copy(isCreating = false, formError = result.message ?: result.exception.message)
                    WResult.Loading    -> current
                }
            }
            if (result is WResult.Success) load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            val result = repo.getExpenses(category = _state.value.selectedCategory)
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(
                        isLoading = false,
                        expenses  = result.data,
                        error     = null,
                    )
                    is WResult.Error   -> current.copy(
                        isLoading = false,
                        error     = result.message ?: result.exception.message ?: "Failed to load expenses",
                    )
                    WResult.Loading    -> current.copy(isLoading = true)
                }
            }
        }
    }
}

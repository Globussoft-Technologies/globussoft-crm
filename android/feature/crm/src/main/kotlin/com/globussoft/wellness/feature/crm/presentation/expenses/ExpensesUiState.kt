package com.globussoft.wellness.feature.crm.presentation.expenses

import com.globussoft.wellness.core.domain.model.Expense

data class ExpensesUiState(
    val isLoading: Boolean = false,
    val expenses: List<Expense> = emptyList(),
    val error: String? = null,
    val selectedCategory: String? = null,
    val isManager: Boolean = false,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

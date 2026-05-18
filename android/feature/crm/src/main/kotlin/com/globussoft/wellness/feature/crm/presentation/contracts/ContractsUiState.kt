package com.globussoft.wellness.feature.crm.presentation.contracts

data class ContractsUiState(
    val isLoading: Boolean = false,
    val contracts: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val selectedStatus: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

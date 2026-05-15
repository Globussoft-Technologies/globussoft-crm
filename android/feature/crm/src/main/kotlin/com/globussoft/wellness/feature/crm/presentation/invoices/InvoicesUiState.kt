package com.globussoft.wellness.feature.crm.presentation.invoices

import com.globussoft.wellness.core.domain.model.Invoice

data class InvoicesUiState(
    val isLoading: Boolean = false,
    val invoices: List<Invoice> = emptyList(),
    val error: String? = null,
    val selectedStatus: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

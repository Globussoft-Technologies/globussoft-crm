package com.globussoft.wellness.feature.crm.presentation.leads

import com.globussoft.wellness.core.domain.model.Contact

data class LeadsUiState(
    val isLoading: Boolean = false,
    val leads: List<Contact> = emptyList(),
    val error: String? = null,
    val search: String = "",
    val selectedSource: String? = null,
    val showAddForm: Boolean = false,
    val editingLead: Contact? = null,
    val isCreating: Boolean = false,
    val formError: String? = null,
    val deleteConfirmId: String? = null,
    val convertingId: String? = null,
)

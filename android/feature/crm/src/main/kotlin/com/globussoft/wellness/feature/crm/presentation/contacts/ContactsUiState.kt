package com.globussoft.wellness.feature.crm.presentation.contacts

import com.globussoft.wellness.core.domain.model.Contact

data class ContactsUiState(
    val isLoading: Boolean = false,
    val contacts: List<Contact> = emptyList(),
    val error: String? = null,
    val selectedStatus: String? = null,
    val search: String = "",
    val showAddForm: Boolean = false,
    val editingContact: Contact? = null,
    val isCreating: Boolean = false,
    val formError: String? = null,
    val deleteConfirmId: String? = null,
)

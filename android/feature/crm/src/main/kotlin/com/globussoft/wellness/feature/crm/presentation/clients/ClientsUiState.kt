package com.globussoft.wellness.feature.crm.presentation.clients

import com.globussoft.wellness.core.domain.model.Contact

data class ClientsUiState(
    val isLoading: Boolean = false,
    val clients: List<Contact> = emptyList(),
    val error: String? = null,
    val searchQuery: String = "",
)

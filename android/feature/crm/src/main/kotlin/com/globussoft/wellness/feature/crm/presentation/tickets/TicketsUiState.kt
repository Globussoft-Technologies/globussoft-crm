package com.globussoft.wellness.feature.crm.presentation.tickets

import com.globussoft.wellness.core.domain.model.Ticket

data class TicketsUiState(
    val isLoading: Boolean = false,
    val tickets: List<Ticket> = emptyList(),
    val error: String? = null,
    val selectedStatus: String? = null,
    val selectedPriority: String? = null,
    val showAddForm: Boolean = false,
    val editingTicket: Ticket? = null,
    val isCreating: Boolean = false,
    val formError: String? = null,
    val deleteConfirmId: String? = null,
)

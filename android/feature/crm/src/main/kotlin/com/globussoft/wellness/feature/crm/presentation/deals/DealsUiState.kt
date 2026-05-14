package com.globussoft.wellness.feature.crm.presentation.deals

import com.globussoft.wellness.core.domain.model.Deal

data class DealsUiState(
    val isLoading: Boolean = false,
    val deals: List<Deal> = emptyList(),
    val error: String? = null,
    val selectedStage: String? = null,
    val selectedStatus: String? = null,
    val showAddForm: Boolean = false,
    val editingDeal: Deal? = null,
    val isCreating: Boolean = false,
    val formError: String? = null,
    val deleteConfirmId: String? = null,
)

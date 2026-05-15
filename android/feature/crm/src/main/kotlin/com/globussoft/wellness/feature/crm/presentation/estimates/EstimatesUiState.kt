package com.globussoft.wellness.feature.crm.presentation.estimates

import com.globussoft.wellness.core.domain.model.Estimate

data class EstimatesUiState(
    val isLoading: Boolean = false,
    val estimates: List<Estimate> = emptyList(),
    val error: String? = null,
    val selectedStatus: String? = null,
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)

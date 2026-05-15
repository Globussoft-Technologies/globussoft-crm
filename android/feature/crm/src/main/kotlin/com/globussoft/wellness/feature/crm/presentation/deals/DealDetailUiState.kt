package com.globussoft.wellness.feature.crm.presentation.deals

import com.globussoft.wellness.core.domain.model.Deal
import com.globussoft.wellness.core.domain.model.Pipeline

data class DealDetailUiState(
    val isLoading: Boolean = true,
    val deal: Deal? = null,
    val pipelines: List<Pipeline> = emptyList(),
    val error: String? = null,
    val showStageSheet: Boolean = false,
    val isUpdating: Boolean = false,
    val showEditForm: Boolean = false,
    val formError: String? = null,
)

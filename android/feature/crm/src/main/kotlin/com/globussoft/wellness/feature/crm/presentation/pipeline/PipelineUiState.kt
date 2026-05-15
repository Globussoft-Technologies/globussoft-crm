package com.globussoft.wellness.feature.crm.presentation.pipeline

import com.globussoft.wellness.core.domain.model.Deal
import com.globussoft.wellness.core.domain.model.Pipeline

data class PipelineUiState(
    val isLoading: Boolean = false,
    val pipelines: List<Pipeline> = emptyList(),
    val selectedPipelineId: String? = null,
    val deals: List<Deal> = emptyList(),
    val selectedStage: String? = null,
    val dealsLoading: Boolean = false,
    val error: String? = null,
)

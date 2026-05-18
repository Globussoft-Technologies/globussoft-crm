package com.globussoft.wellness.feature.crm.presentation.forecasting

import com.globussoft.wellness.core.domain.model.ForecastEntry

data class ForecastingUiState(
    val isLoading: Boolean = false,
    val entries: List<ForecastEntry> = emptyList(),
    val error: String? = null,
    val selectedPeriod: String = "All",
)

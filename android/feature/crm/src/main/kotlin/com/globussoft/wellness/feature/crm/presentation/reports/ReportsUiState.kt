package com.globussoft.wellness.feature.crm.presentation.reports

data class ReportsUiState(
    val isLoading: Boolean = false,
    val overview: Map<String, Any> = emptyMap(),
    val agentPerformance: List<Map<String, Any>> = emptyList(),
    val winLoss: Map<String, Any> = emptyMap(),
    val funnel: Map<String, Any> = emptyMap(),
    val error: String? = null,
    val selectedTab: Int = 0,
    val fromDate: String = "",
    val toDate: String = "",
)

package com.globussoft.wellness.core.domain.model

data class ForecastEntry(
    val stage: String,
    val dealCount: Int,
    val totalValue: Double,
    val weightedValue: Double,
    val probability: Int,
)

data class ForecastSnapshot(
    val month: String,
    val weightedRevenue: Double,
    val actualRevenue: Double?,
)

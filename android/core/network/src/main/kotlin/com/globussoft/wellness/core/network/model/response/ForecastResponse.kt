package com.globussoft.wellness.core.network.model.response

data class ForecastResponse(
    val stage: String,
    val dealCount: Int,
    val totalValue: Double,
    val weightedValue: Double,
    val probability: Int,
)

data class ForecastSnapshotResponse(
    val month: String,
    val weightedRevenue: Double,
    val actualRevenue: Double?,
)

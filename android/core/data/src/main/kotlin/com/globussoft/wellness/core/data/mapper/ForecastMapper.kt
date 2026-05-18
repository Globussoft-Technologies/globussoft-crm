package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.ForecastEntry
import com.globussoft.wellness.core.domain.model.ForecastSnapshot
import com.globussoft.wellness.core.network.model.response.ForecastResponse
import com.globussoft.wellness.core.network.model.response.ForecastSnapshotResponse

fun ForecastResponse.toDomain(): ForecastEntry = ForecastEntry(
    stage = stage,
    dealCount = dealCount,
    totalValue = totalValue,
    weightedValue = weightedValue,
    probability = probability,
)

fun ForecastSnapshotResponse.toDomain(): ForecastSnapshot = ForecastSnapshot(
    month = month,
    weightedRevenue = weightedRevenue,
    actualRevenue = actualRevenue,
)

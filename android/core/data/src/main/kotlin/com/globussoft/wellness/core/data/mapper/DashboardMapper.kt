package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.DashboardData
import com.globussoft.wellness.core.domain.model.RevenueTrendPoint
import com.globussoft.wellness.core.network.model.response.DashboardResponse
import com.globussoft.wellness.core.network.model.response.RevenueTrendPointResponse

/**
 * Maps a [DashboardResponse] network DTO to the [DashboardData] domain model.
 *
 * The [revenueTrend] list is mapped element-by-element via the companion
 * extension so the transformation stays composable and testable in isolation.
 */
fun DashboardResponse.toDomain(): DashboardData = DashboardData(
    todayVisits           = todayVisits,
    completedVisits       = completedVisits,
    revenueMonth          = revenueMonth,
    occupancyPercent      = occupancyPercent,
    newLeads              = newLeads,
    pendingApprovals      = pendingApprovals,
    activeTreatmentPlans  = activeTreatmentPlans,
    noShowRisk            = noShowRisk,
    yesterdayRevenue      = yesterdayRevenue,
    yesterdayVisits       = yesterdayVisits,
    patientTotal          = patientTotal,
    serviceTotal          = serviceTotal,
    revenueTrend          = revenueTrend.map { it.toDomain() },
)

/**
 * Maps a single [RevenueTrendPointResponse] to the [RevenueTrendPoint] domain model.
 */
fun RevenueTrendPointResponse.toDomain(): RevenueTrendPoint = RevenueTrendPoint(
    date   = date,
    amount = amount,
)

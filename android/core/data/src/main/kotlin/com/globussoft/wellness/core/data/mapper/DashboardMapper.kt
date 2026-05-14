package com.globussoft.wellness.core.data.mapper

import com.globussoft.wellness.core.domain.model.DashboardData
import com.globussoft.wellness.core.domain.model.RevenueTrendPoint
import com.globussoft.wellness.core.network.model.response.DashboardResponse
import com.globussoft.wellness.core.network.model.response.RevenueTrendPointResponse

/**
 * Maps a [DashboardResponse] network DTO to the [DashboardData] domain model.
 *
 * The server returns nested objects (today/yesterday/totals); this mapper
 * flattens them into the domain model's flat structure for convenience.
 *
 * [revenueMonth] is computed as the sum of all points in the [revenueTrend]
 * list since the server does not return a pre-aggregated monthly total.
 *
 * The [revenueTrend] list is mapped element-by-element via the companion
 * extension so the transformation stays composable and testable in isolation.
 */
fun DashboardResponse.toDomain(): DashboardData = DashboardData(
    todayVisits          = today.visits,
    completedVisits      = today.completed,
    revenueMonth         = revenueTrend.sumOf { it.revenue },
    occupancyPercent     = today.occupancyPct.toDouble(),
    newLeads             = today.newLeads,
    pendingApprovals     = pendingApprovals,
    activeTreatmentPlans = activeTreatmentPlans,
    noShowRisk           = today.noShowRisk.count,
    yesterdayRevenue     = yesterday.revenue,
    yesterdayVisits      = yesterday.visits,
    patientTotal         = totals.patients,
    serviceTotal         = totals.services,
    revenueTrend         = revenueTrend.map { it.toDomain() },
)

/**
 * Maps a single [RevenueTrendPointResponse] to the [RevenueTrendPoint] domain model.
 */
fun RevenueTrendPointResponse.toDomain(): RevenueTrendPoint = RevenueTrendPoint(
    date   = date,
    amount = revenue,
)

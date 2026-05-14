package com.globussoft.wellness.core.network.model.response

/**
 * Owner Dashboard aggregate payload as returned by GET /api/wellness/dashboard.
 *
 * All monetary values are in the tenant's configured default currency.
 *
 * Server shape:
 * {
 *   "today": {"visits": 8, "completed": 0, "expectedRevenue": 8632,
 *             "occupancyPct": 6, "newLeads": 0,
 *             "noShowRisk": {"count": 0, "totalUpcoming": 8}},
 *   "yesterday": {"visits": 26, "completed": 0, "revenue": 0},
 *   "pendingApprovals": 5,
 *   "pendingRecommendations": [...],
 *   "activeTreatmentPlans": 104,
 *   "revenueTrend": [{"date": "2026-04-14", "revenue": 5831.9}, ...],
 *   "totals": {"patients": 103, "services": 109, "locations": 1}
 * }
 */
data class DashboardResponse(
    val today: DashboardTodayResponse,
    val yesterday: DashboardYesterdayResponse,
    val pendingApprovals: Int,
    val pendingRecommendations: List<RecommendationResponse>,
    val activeTreatmentPlans: Int,
    val revenueTrend: List<RevenueTrendPointResponse>,
    val totals: DashboardTotalsResponse,
)

/**
 * Today's metrics embedded in [DashboardResponse].
 *
 * [occupancyPct]     — appointment-slot utilisation rate for today (0–100 int).
 * [noShowRisk]       — count of upcoming bookings flagged as high no-show risk.
 */
data class DashboardTodayResponse(
    val visits: Int,
    val completed: Int,
    val expectedRevenue: Double,
    val occupancyPct: Int,
    val newLeads: Int,
    val noShowRisk: NoShowRiskResponse,
)

/**
 * Yesterday's summary metrics embedded in [DashboardResponse].
 */
data class DashboardYesterdayResponse(
    val visits: Int,
    val completed: Int,
    val revenue: Double,
)

/**
 * No-show risk counts embedded in [DashboardTodayResponse].
 *
 * [count]         — number of bookings with elevated no-show risk.
 * [totalUpcoming] — total upcoming bookings considered.
 */
data class NoShowRiskResponse(
    val count: Int,
    val totalUpcoming: Int,
)

/**
 * Aggregate totals embedded in [DashboardResponse].
 */
data class DashboardTotalsResponse(
    val patients: Int,
    val services: Int,
    val locations: Int,
)

/**
 * A single daily revenue data point within [DashboardResponse.revenueTrend].
 *
 * [date]    — ISO-8601 date string "yyyy-MM-dd".
 * [revenue] — total revenue collected on that date in the tenant's currency.
 */
data class RevenueTrendPointResponse(
    val date: String,
    val revenue: Double,
)

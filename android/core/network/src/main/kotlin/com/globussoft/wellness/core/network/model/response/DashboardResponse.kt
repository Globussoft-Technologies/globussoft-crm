package com.globussoft.wellness.core.network.model.response

/**
 * Owner Dashboard aggregate payload as returned by GET /api/wellness/dashboard.
 *
 * All monetary values are in the tenant's configured default currency.
 *
 * [occupancyPercent]     — appointment-slot utilisation rate for today (0.0–100.0).
 * [noShowRisk]           — count of upcoming bookings flagged as high no-show risk.
 * [activeTreatmentPlans] — count of in-progress multi-session treatment plans.
 * [revenueTrend]         — ordered daily data points for the trailing-30-day sparkline.
 */
data class DashboardResponse(
    val todayVisits: Int,
    val completedVisits: Int,
    val revenueMonth: Double,
    val occupancyPercent: Double,
    val newLeads: Int,
    val pendingApprovals: Int,
    val activeTreatmentPlans: Int,
    val noShowRisk: Int,
    val yesterdayRevenue: Double,
    val yesterdayVisits: Int,
    val patientTotal: Int,
    val serviceTotal: Int,
    val revenueTrend: List<RevenueTrendPointResponse>,
)

/**
 * A single daily revenue data point within [DashboardResponse.revenueTrend].
 *
 * [date]   — ISO-8601 date string "yyyy-MM-dd".
 * [amount] — total revenue collected on that date in the tenant's currency.
 */
data class RevenueTrendPointResponse(
    val date: String,
    val amount: Double,
)

package com.globussoft.wellness.core.domain.model

/**
 * Aggregated data for the wellness Owner Dashboard screen.
 *
 * All monetary values are in the tenant's [defaultCurrency].
 *
 * [occupancyPercent]     — appointment-slot utilisation rate for today (0-100).
 * [noShowRisk]           — count of upcoming bookings flagged as high no-show risk
 *                          by the AI scoring engine.
 * [activeTreatmentPlans] — count of in-progress multi-session treatment plans.
 * [revenueTrend]         — ordered list of daily revenue data points for the
 *                          trailing 30-day sparkline chart.
 */
data class DashboardData(
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
    val revenueTrend: List<RevenueTrendPoint>,
)

/**
 * A single data point in the revenue trend sparkline.
 *
 * [date]   — ISO-8601 date string `"yyyy-MM-dd"`.
 * [amount] — total revenue collected on that date.
 */
data class RevenueTrendPoint(
    val date: String,
    val amount: Double,
)

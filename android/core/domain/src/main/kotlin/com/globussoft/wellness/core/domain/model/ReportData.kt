package com.globussoft.wellness.core.domain.model

/**
 * P&L breakdown aggregated by service category.
 *
 * [margin] — gross margin percentage; null when cost data is unavailable.
 */
data class PnlByService(
    val serviceName: String,
    val visits: Int,
    val amount: Double,
    val margin: Double?,
)

/**
 * Performance summary for an individual doctor or professional.
 *
 * [utilizationPercent] — proportion of scheduled slots that were filled;
 *                        null when slot data is unavailable for this professional.
 */
data class PerProfessional(
    val doctorName: String,
    val visits: Int,
    val revenue: Double,
    val utilizationPercent: Double?,
)

/**
 * Revenue and visit count aggregated per clinic location.
 */
data class PerLocation(
    val locationName: String,
    val visits: Int,
    val revenue: Double,
)

/**
 * Marketing-channel attribution data.
 *
 * [roi] — return on investment as a multiplier (e.g. 3.5 = 3.5×);
 *         null when spend data is unavailable for the channel.
 */
data class AttributionData(
    val channel: String,
    val leads: Int,
    val conversions: Int,
    val roi: Double?,
)

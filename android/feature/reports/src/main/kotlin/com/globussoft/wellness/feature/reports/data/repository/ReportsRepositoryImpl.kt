package com.globussoft.wellness.feature.reports.data.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.AttributionData
import com.globussoft.wellness.core.domain.model.PerLocation
import com.globussoft.wellness.core.domain.model.PerProfessional
import com.globussoft.wellness.core.domain.model.PnlByService
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.reports.domain.repository.ReportsRepository
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Production implementation of [ReportsRepository].
 *
 * Delegates each query to the corresponding [WellnessApi] endpoint via
 * [safeApiCall].  The raw API responses are `List<Map<String, Any>>` — each
 * record is a free-form JSON object.  The private mapper extensions below
 * extract the known keys and coerce them to the appropriate Kotlin types,
 * defaulting gracefully when a key is absent or has an unexpected type.
 *
 * Key conventions used by the backend wellness reports endpoints:
 * - P&L:            serviceName, visits, amount, margin
 * - Per-Professional: doctorName, visits, revenue, utilizationPercent
 * - Per-Location:   locationName, visits, revenue
 * - Attribution:    channel, leads, conversions, roi
 */
@Singleton
class ReportsRepositoryImpl @Inject constructor(
    private val api: WellnessApi,
) : ReportsRepository {

    override suspend fun getPnlByService(from: String, to: String): WResult<List<PnlByService>> =
        safeApiCall { api.getPnlByService(from = from, to = to) }
            .mapSuccess { envelope ->
                @Suppress("UNCHECKED_CAST")
                val rows = (envelope["rows"] ?: envelope["servicesSummary"]) as? List<*>
                rows?.filterIsInstance<Map<*, *>>()?.map { it.toRawMap().toPnlByService() } ?: emptyList()
            }

    override suspend fun getPerProfessional(from: String, to: String): WResult<List<PerProfessional>> =
        safeApiCall { api.getPerProfessional(from = from, to = to) }
            .mapSuccess { envelope ->
                @Suppress("UNCHECKED_CAST")
                val rows = envelope["rows"] as? List<*>
                rows?.filterIsInstance<Map<*, *>>()?.map { it.toRawMap().toPerProfessional() } ?: emptyList()
            }

    override suspend fun getPerLocation(from: String, to: String): WResult<List<PerLocation>> =
        safeApiCall { api.getPerLocation(from = from, to = to) }
            .mapSuccess { envelope ->
                @Suppress("UNCHECKED_CAST")
                val rows = envelope["rows"] as? List<*>
                rows?.filterIsInstance<Map<*, *>>()?.map { it.toRawMap().toPerLocation() } ?: emptyList()
            }

    override suspend fun getAttribution(from: String, to: String): WResult<List<AttributionData>> =
        safeApiCall { api.getAttribution(from = from, to = to) }
            .mapSuccess { envelope ->
                @Suppress("UNCHECKED_CAST")
                val rows = envelope["rows"] as? List<*>
                rows?.filterIsInstance<Map<*, *>>()?.map { it.toRawMap().toAttributionData() } ?: emptyList()
            }

    // -------------------------------------------------------------------------
    // Map helpers
    // -------------------------------------------------------------------------

    // Backend P&L row: {id, name, category, ticketTier, count, revenue, productCost, contribution}
    private fun Map<String, Any>.toPnlByService(): PnlByService {
        val revenue = doubleOrZero("revenue")
        val contribution = doubleOrZero("contribution")
        val margin = if (revenue > 0) contribution / revenue else null
        return PnlByService(
            serviceName = stringOrEmpty("name"),
            visits      = intOrZero("count"),
            amount      = revenue,
            margin      = margin,
        )
    }

    // Backend per-professional row: {id, name, role, wellnessRole, visits, revenue}
    private fun Map<String, Any>.toPerProfessional() = PerProfessional(
        doctorName         = stringOrEmpty("name"),
        visits             = intOrZero("visits"),
        revenue            = doubleOrZero("revenue"),
        utilizationPercent = null,
    )

    // Backend per-location row: {id, name, city, state, isActive, visits, revenue, patients}
    private fun Map<String, Any>.toPerLocation() = PerLocation(
        locationName = stringOrEmpty("name"),
        visits       = intOrZero("visits"),
        revenue      = doubleOrZero("revenue"),
    )

    // Backend attribution row: {source, leads, junk, qualified, revenue, junkRate, conversionRate, revenuePerLead}
    private fun Map<String, Any>.toAttributionData() = AttributionData(
        channel     = stringOrEmpty("source"),
        leads       = intOrZero("leads"),
        conversions = intOrZero("qualified"),
        roi         = null,
    )

    private fun Map<*, *>.toRawMap(): Map<String, Any> =
        entries.associate { (k, v) -> k.toString() to (v ?: "") }

    // -------------------------------------------------------------------------
    // Coercion helpers
    // -------------------------------------------------------------------------

    private fun Map<String, Any>.stringOrEmpty(key: String): String =
        this[key]?.toString() ?: ""

    private fun Map<String, Any>.intOrZero(key: String): Int =
        when (val v = this[key]) {
            is Number -> v.toInt()
            is String -> v.toIntOrNull() ?: 0
            else      -> 0
        }

    private fun Map<String, Any>.doubleOrZero(key: String): Double =
        when (val v = this[key]) {
            is Number -> v.toDouble()
            is String -> v.toDoubleOrNull() ?: 0.0
            else      -> 0.0
        }

    private fun Map<String, Any>.doubleOrNull(key: String): Double? =
        when (val v = this[key]) {
            null      -> null
            is Number -> v.toDouble()
            is String -> v.toDoubleOrNull()
            else      -> null
        }
}

// ─── Local mapping helper (same pattern as DashboardRepositoryImpl) ───────────

private inline fun <T, R> WResult<T>.mapSuccess(transform: (T) -> R): WResult<R> =
    when (this) {
        is WResult.Success -> WResult.Success(transform(data))
        is WResult.Error   -> this
        WResult.Loading    -> WResult.Loading
    }

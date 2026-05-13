package com.globussoft.wellness.feature.reports.domain.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.AttributionData
import com.globussoft.wellness.core.domain.model.PerLocation
import com.globussoft.wellness.core.domain.model.PerProfessional
import com.globussoft.wellness.core.domain.model.PnlByService

/**
 * Contract for the Wellness Reports data layer.
 *
 * Each method accepts an inclusive ISO-8601 date range ([from], [to]) and
 * returns a typed [WResult] wrapping the domain model list.  The repository
 * hides whether data comes from the network, a cache, or a database — callers
 * in the presentation layer only depend on this interface.
 */
interface ReportsRepository {

    /**
     * Returns P&L revenue breakdown aggregated by service category for the
     * given date range.
     */
    suspend fun getPnlByService(from: String, to: String): WResult<List<PnlByService>>

    /**
     * Returns visit and revenue performance for each doctor / professional for
     * the given date range.
     */
    suspend fun getPerProfessional(from: String, to: String): WResult<List<PerProfessional>>

    /**
     * Returns visit count and revenue aggregated per clinic location for the
     * given date range.
     */
    suspend fun getPerLocation(from: String, to: String): WResult<List<PerLocation>>

    /**
     * Returns marketing-channel attribution data (leads, conversions, ROI) for
     * the given date range.
     */
    suspend fun getAttribution(from: String, to: String): WResult<List<AttributionData>>
}

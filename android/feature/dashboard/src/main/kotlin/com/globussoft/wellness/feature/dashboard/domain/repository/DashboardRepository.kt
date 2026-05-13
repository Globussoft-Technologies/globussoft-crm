package com.globussoft.wellness.feature.dashboard.domain.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.DashboardData
import com.globussoft.wellness.core.domain.model.Recommendation

/**
 * Domain contract for the Owner Dashboard and AI Recommendations data.
 *
 * Implemented by [com.globussoft.wellness.feature.dashboard.data.repository.DashboardRepositoryImpl]
 * and bound via [com.globussoft.wellness.feature.dashboard.di.DashboardModule].
 *
 * All methods return [WResult] so callers can exhaustively handle success,
 * loading, and error states without try/catch blocks in the ViewModel.
 */
interface DashboardRepository {

    /**
     * Fetches aggregated KPI and trend data for the Owner Dashboard.
     *
     * @param locationId When non-null the server scopes KPIs to that specific
     *                   clinic branch; when null the response covers all branches.
     */
    suspend fun getDashboardData(locationId: String? = null): WResult<DashboardData>

    /**
     * Fetches the list of AI-generated recommendation cards.
     *
     * @param status Optional filter: "pending" | "approved" | "rejected" | null (all).
     */
    suspend fun getRecommendations(status: String? = null): WResult<List<Recommendation>>

    /**
     * Approves a single recommendation card.
     *
     * @param id The recommendation's server-side UUID.
     * @return The updated [Recommendation] with status "approved".
     */
    suspend fun approveRecommendation(id: String): WResult<Recommendation>

    /**
     * Rejects a single recommendation card.
     *
     * @param id The recommendation's server-side UUID.
     * @return The updated [Recommendation] with status "rejected".
     */
    suspend fun rejectRecommendation(id: String): WResult<Recommendation>

    /**
     * Manually triggers the wellness orchestrator engine for the tenant.
     *
     * Produces a new batch of [Recommendation] cards within a few seconds;
     * the caller should refresh the recommendations list after the call succeeds.
     */
    suspend fun runOrchestrator(): WResult<Unit>
}

package com.globussoft.wellness.feature.dashboard.data.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.mapper.toDomain
import com.globussoft.wellness.core.domain.model.DashboardData
import com.globussoft.wellness.core.domain.model.Recommendation
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.dashboard.domain.repository.DashboardRepository
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Production implementation of [DashboardRepository].
 *
 * Each operation delegates to the corresponding [WellnessApi] endpoint via
 * [safeApiCall], which maps HTTP/network failures to typed [WResult.Error]
 * variants before returning to the ViewModel.
 *
 * Domain mappers ([toDomain]) live in [core:data] so they remain reusable
 * across feature modules that share the same network response types.
 */
@Singleton
class DashboardRepositoryImpl @Inject constructor(
    private val api: WellnessApi,
) : DashboardRepository {

    override suspend fun getDashboardData(locationId: String?): WResult<DashboardData> =
        safeApiCall { api.getDashboard(locationId = locationId) }
            .mapSuccess { it.toDomain() }

    override suspend fun getRecommendations(status: String?): WResult<List<Recommendation>> =
        safeApiCall { api.getRecommendations(status = status) }
            .mapSuccess { list -> list.map { it.toDomain() } }

    override suspend fun approveRecommendation(id: String): WResult<Recommendation> =
        safeApiCall { api.approveRecommendation(id) }
            .mapSuccess { it.toDomain() }

    override suspend fun rejectRecommendation(id: String): WResult<Recommendation> =
        safeApiCall { api.rejectRecommendation(id) }
            .mapSuccess { it.toDomain() }

    override suspend fun runOrchestrator(): WResult<Unit> =
        safeApiCall { api.runOrchestrator() }
}

// ─── Local mapping helper ─────────────────────────────────────────────────────

/**
 * Transforms the [WResult.Success] data value with [transform] while leaving
 * [WResult.Error] and [WResult.Loading] variants unchanged.
 *
 * Avoids the verbose `when (result) { is WResult.Success -> ... else -> result }`
 * pattern at every call site in this class.
 */
private inline fun <T, R> WResult<T>.mapSuccess(transform: (T) -> R): WResult<R> =
    when (this) {
        is WResult.Success -> WResult.Success(transform(data))
        is WResult.Error   -> this
        WResult.Loading    -> WResult.Loading
    }

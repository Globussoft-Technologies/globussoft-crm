package com.globussoft.wellness.feature.telecaller.data.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.mapper.toDomain
import com.globussoft.wellness.core.domain.model.Lead
import com.globussoft.wellness.core.domain.model.Service
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.model.request.DispositionRequest
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.telecaller.domain.repository.TelecallerRepository
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Production implementation of [TelecallerRepository].
 *
 * All operations delegate to [WellnessApi] via [safeApiCall] so HTTP/network
 * errors are mapped to typed [WResult.Error] variants before the ViewModel sees
 * them.  The raw DTOs are converted to domain models using the shared [toDomain]
 * extensions from [core:data].
 */
@Singleton
class TelecallerRepositoryImpl @Inject constructor(
    private val api: WellnessApi,
) : TelecallerRepository {

    override suspend fun getQueue(): WResult<List<Lead>> =
        safeApiCall { api.getTelecallerQueue() }
            .mapSuccess { response -> response.leads.map { it.toDomain() } }

    override suspend fun getServices(): WResult<List<Service>> =
        safeApiCall { api.getServices() }
            .mapSuccess { list -> list.map { it.toDomain() } }

    override suspend fun disposeLead(leadId: String, request: DispositionRequest): WResult<Unit> =
        safeApiCall { api.disposeLead(leadId = leadId, req = request) }
}

// ─── Local mapping helper ─────────────────────────────────────────────────────

private inline fun <T, R> WResult<T>.mapSuccess(transform: (T) -> R): WResult<R> =
    when (this) {
        is WResult.Success -> WResult.Success(transform(data))
        is WResult.Error   -> this
        WResult.Loading    -> WResult.Loading
    }

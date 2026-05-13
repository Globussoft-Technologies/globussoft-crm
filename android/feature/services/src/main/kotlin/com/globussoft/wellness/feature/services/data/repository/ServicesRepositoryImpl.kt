package com.globussoft.wellness.feature.services.data.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.mapper.toDomain
import com.globussoft.wellness.core.domain.model.Service
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.services.domain.repository.ServicesRepository
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Production implementation of [ServicesRepository].
 *
 * All operations are network-first — the service catalog is a low-volume admin
 * resource that changes infrequently (a few updates per week at most). Room
 * caching is not applied here; if offline support is required in a future
 * iteration, add a `ServiceEntity` + DAO to the [core:database] module and
 * apply the same offline-first pattern used by `PatientsRepositoryImpl`.
 *
 * [createService] and [updateService] accept `Map<String, Any>` so that the
 * repository stays shape-agnostic — the ViewModel is the source of truth for
 * which fields to include, and Retrofit's `@JvmSuppressWildcards` annotation on
 * the API interface handles the Kotlin generics at serialization time.
 */
@Singleton
class ServicesRepositoryImpl @Inject constructor(
    private val api: WellnessApi,
) : ServicesRepository {

    override suspend fun getServices(): WResult<List<Service>> =
        safeApiCall { api.getServices() }
            .mapSuccess { list -> list.map { it.toDomain() } }

    override suspend fun createService(params: Map<String, Any>): WResult<Service> =
        safeApiCall { api.createService(params) }
            .mapSuccess { it.toDomain() }

    override suspend fun updateService(id: String, params: Map<String, Any>): WResult<Service> =
        safeApiCall { api.updateService(id, params) }
            .mapSuccess { it.toDomain() }

    override suspend fun deleteService(id: String): WResult<Unit> =
        safeApiCall { api.deleteService(id) }
            .mapSuccess { }
}

// ─── Private extension ────────────────────────────────────────────────────────

private inline fun <T, R> WResult<T>.mapSuccess(transform: (T) -> R): WResult<R> =
    when (this) {
        is WResult.Success -> WResult.Success(transform(data))
        is WResult.Error   -> this
        WResult.Loading    -> WResult.Loading
    }

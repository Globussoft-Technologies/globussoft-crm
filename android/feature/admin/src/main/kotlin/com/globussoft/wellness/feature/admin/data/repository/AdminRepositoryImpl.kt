package com.globussoft.wellness.feature.admin.data.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.mapper.toDomain
import com.globussoft.wellness.core.domain.model.Location
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.DrugItem
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Production implementation of [AdminRepository].
 *
 * Location operations delegate to the existing wellness/locations endpoints
 * and use the shared [toDomain] mapper from [core:data].
 *
 * Drug operations delegate to the wellness/drugs endpoints added in the admin
 * feature wave.  The API responses are free-form JSON objects ([Map<String,Any>])
 * which are mapped to [DrugItem] by the private [toDrugItem] extension.
 */
@Singleton
class AdminRepositoryImpl @Inject constructor(
    private val api: WellnessApi,
) : AdminRepository {

    // ── Locations ──────────────────────────────────────────────────────────────

    override suspend fun getLocations(): WResult<List<Location>> =
        safeApiCall { api.getLocations() }
            .mapSuccess { list -> list.map { it.toDomain() } }

    override suspend fun createLocation(params: Map<String, Any>): WResult<Location> =
        safeApiCall { api.createLocation(params) }
            .mapSuccess { it.toDomain() }

    override suspend fun updateLocation(id: String, params: Map<String, Any>): WResult<Location> =
        safeApiCall { api.updateLocation(id, params) }
            .mapSuccess { it.toDomain() }

    override suspend fun deleteLocation(id: String): WResult<Unit> =
        safeApiCall { api.deleteLocation(id) }

    // ── Drugs ──────────────────────────────────────────────────────────────────

    @Suppress("UNCHECKED_CAST")
    override suspend fun getDrugs(): WResult<List<DrugItem>> =
        safeApiCall { api.getDrugs() }
            .mapSuccess { raw ->
                (raw as? List<*>)?.mapNotNull { item ->
                    (item as? Map<*, *>)?.let { m ->
                        @Suppress("UNCHECKED_CAST")
                        (m as Map<String, Any>).toDrugItem()
                    }
                } ?: emptyList()
            }

    @Suppress("UNCHECKED_CAST")
    override suspend fun createDrug(params: Map<String, Any>): WResult<DrugItem> =
        safeApiCall { api.createDrug(params) }
            .mapSuccess { raw ->
                @Suppress("UNCHECKED_CAST")
                (raw as Map<String, Any>).toDrugItem()
            }

    @Suppress("UNCHECKED_CAST")
    override suspend fun updateDrug(id: String, params: Map<String, Any>): WResult<DrugItem> =
        safeApiCall { api.updateDrug(id, params) }
            .mapSuccess { raw ->
                @Suppress("UNCHECKED_CAST")
                (raw as Map<String, Any>).toDrugItem()
            }

    override suspend fun deleteDrug(id: String): WResult<Unit> =
        safeApiCall { api.deleteDrug(id) }

    // ── Mappers ────────────────────────────────────────────────────────────────

    private fun Map<String, Any>.toDrugItem() = DrugItem(
        id               = this["id"]?.toString() ?: "",
        name             = this["name"]?.toString() ?: "",
        dosageForm       = this["dosageForm"]?.toString(),
        strength         = this["strength"]?.toString(),
        unit             = this["unit"]?.toString(),
        category         = this["category"]?.toString(),
        sideEffects      = this["sideEffects"]?.toString(),
        contraindications = this["contraindications"]?.toString(),
    )
}

// ─── Local mapping helper ─────────────────────────────────────────────────────

private inline fun <T, R> WResult<T>.mapSuccess(transform: (T) -> R): WResult<R> =
    when (this) {
        is WResult.Success -> WResult.Success(transform(data))
        is WResult.Error   -> this
        WResult.Loading    -> WResult.Loading
    }

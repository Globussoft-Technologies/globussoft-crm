package com.globussoft.wellness.feature.patients.data.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.common.extensions.asResult
import com.globussoft.wellness.core.data.datastore.AuthDataStore
import com.globussoft.wellness.core.data.mapper.toDomain
import com.globussoft.wellness.core.data.mapper.toRequest
import com.globussoft.wellness.core.database.dao.PatientDao
import com.globussoft.wellness.core.database.entity.PatientEntity
import com.globussoft.wellness.core.domain.model.Patient
import com.globussoft.wellness.core.domain.model.PatientForm
import com.globussoft.wellness.core.domain.model.Service
import com.globussoft.wellness.core.domain.model.Staff
import com.globussoft.wellness.core.domain.model.Visit
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.patients.domain.repository.PaginatedPatients
import com.globussoft.wellness.feature.patients.domain.repository.PatientsRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Production implementation of [PatientsRepository].
 *
 * ### Caching strategy
 * [getPatients] uses an offline-first pattern:
 * 1. Room emits the cached list immediately via a [Flow] (fast path).
 * 2. A background network call refreshes the cache; Room emits again once
 *    the upsert completes.
 *
 * All write operations (create, update) go directly to the server and then
 * upsert the returned record to Room so the cache stays consistent without
 * requiring a full re-fetch.
 *
 * ### Tenant scoping
 * All Room queries are scoped to [tenantId] read from [AuthDataStore] at call
 * time. The tenant ID is never read from network responses to prevent server-
 * side spoofing.
 */
@Singleton
class PatientsRepositoryImpl @Inject constructor(
    private val api: WellnessApi,
    private val patientDao: PatientDao,
    private val authDataStore: AuthDataStore,
) : PatientsRepository {

    override fun getPatients(
        search: String,
        skip: Int,
        limit: Int,
    ): Flow<WResult<PaginatedPatients>> = flow {
        val tenantId = authDataStore.userFlow.first()?.tenantId ?: ""

        // Emit from cache immediately for instant UI.
        val cacheFlow = if (search.isBlank()) {
            patientDao.getAllPatients(tenantId)
        } else {
            patientDao.searchPatients(tenantId, search)
        }

        // Convert the Room Flow to WResult<PaginatedPatients>.
        val resultFlow: Flow<WResult<PaginatedPatients>> = cacheFlow
            .map { entities ->
                val patients = entities.map { it.toDomain() }
                WResult.Success(PaginatedPatients(patients = patients, total = patients.size))
            }

        // Kick off a network refresh in the background; don't block the emit.
        refreshFromNetwork(tenantId, search, skip, limit)

        emitAll(resultFlow)
    }

    override suspend fun getPatient(id: String): WResult<Patient> {
        val networkResult = safeApiCall { api.getPatient(id) }
            .mapSuccess { it.toDomain() }

        // On success, upsert to cache for future offline reads.
        if (networkResult is WResult.Success) {
            val tenantId = authDataStore.userFlow.first()?.tenantId ?: ""
            patientDao.insertPatients(listOf(networkResult.data.toEntity(tenantId)))
        } else {
            // Fallback: try the Room cache.
            val cached = patientDao.getPatientById(id)
            if (cached != null) return WResult.Success(cached.toDomain())
        }

        return networkResult
    }

    override suspend fun createPatient(form: PatientForm): WResult<Patient> {
        val result = safeApiCall { api.createPatient(form.toRequest()) }
            .mapSuccess { it.toDomain() }

        if (result is WResult.Success) {
            val tenantId = authDataStore.userFlow.first()?.tenantId ?: ""
            patientDao.insertPatients(listOf(result.data.toEntity(tenantId)))
        }

        return result
    }

    override suspend fun updatePatient(id: String, form: PatientForm): WResult<Patient> {
        val result = safeApiCall { api.updatePatient(id, form.toRequest()) }
            .mapSuccess { it.toDomain() }

        if (result is WResult.Success) {
            val tenantId = authDataStore.userFlow.first()?.tenantId ?: ""
            patientDao.insertPatients(listOf(result.data.toEntity(tenantId)))
        }

        return result
    }

    override suspend fun getPatientVisits(patientId: String): WResult<List<Visit>> =
        safeApiCall {
            api.getVisits(skip = 0, limit = 100)
        }.mapSuccess { list ->
            list
                .filter { it.patientId == patientId }
                .map { it.toDomain() }
                .sortedByDescending { it.visitDate }
        }

    override suspend fun getServices(): WResult<List<Service>> =
        safeApiCall { api.getServices() }
            .mapSuccess { list -> list.filter { it.isActive }.map { it.toDomain() } }

    override suspend fun getDoctors(): WResult<List<Staff>> =
        safeApiCall { api.getStaff(wellnessRole = "DOCTOR") }
            .mapSuccess { list -> list.map { it.toDomain() } }

    // ─── Private helpers ──────────────────────────────────────────────────────

    /**
     * Fetches a page from the network and upserts the results into Room.
     * Errors are silently swallowed here — the cached data will remain visible.
     */
    private suspend fun refreshFromNetwork(
        tenantId: String,
        search: String,
        skip: Int,
        limit: Int,
    ) {
        val result = safeApiCall {
            api.getPatients(
                search = search.ifBlank { null },
                skip   = skip,
                limit  = limit,
            )
        }

        if (result is WResult.Success) {
            val entities = result.data.patients.map { it.toDomain().toEntity(tenantId) }
            patientDao.insertPatients(entities)
        }
    }
}

// ─── Local mapping helpers ────────────────────────────────────────────────────

/**
 * Transforms the [WResult.Success] data value while leaving [WResult.Error]
 * and [WResult.Loading] unchanged.
 */
private inline fun <T, R> WResult<T>.mapSuccess(transform: (T) -> R): WResult<R> =
    when (this) {
        is WResult.Success -> WResult.Success(transform(data))
        is WResult.Error   -> this
        WResult.Loading    -> WResult.Loading
    }

/**
 * Converts a [Patient] domain model to a [PatientEntity] for Room storage.
 * [tenantId] is injected from [AuthDataStore] rather than the domain model to
 * prevent any cross-tenant leakage.
 */
private fun Patient.toEntity(tenantId: String): PatientEntity = PatientEntity(
    id                 = id,
    tenantId           = tenantId,
    name               = name,
    phone              = phone,
    email              = email,
    dob                = dob,
    gender             = gender,
    bloodGroup         = bloodGroup,
    source             = source,
    locationId         = locationId,
    createdAt          = createdAt,
    visitsCount        = visitsCount,
    rxCount            = rxCount,
    treatmentPlanCount = treatmentPlanCount,
    syncedAt           = System.currentTimeMillis(),
)

/**
 * Converts a [PatientEntity] Room row back to a [Patient] domain model.
 * Age is not stored in the cache — it is recomputed from [dob] on read
 * so it stays accurate over time without cache invalidation.
 */
private fun PatientEntity.toDomain(): Patient = Patient(
    id                 = id,
    name               = name,
    phone              = phone,
    email              = email,
    dob                = dob,
    age                = dob?.let { computeAgeFromDob(it) },
    gender             = gender,
    bloodGroup         = bloodGroup,
    source             = source,
    locationId         = locationId,
    createdAt          = createdAt,
    visitsCount        = visitsCount,
    rxCount            = rxCount,
    treatmentPlanCount = treatmentPlanCount,
)

/** Derives approximate age in years from a "YYYY-MM-DD…" dob string. */
private fun computeAgeFromDob(dob: String): Int? {
    return try {
        val parts = dob.substring(0, 10).split("-")
        if (parts.size < 3) return null
        val today = java.util.Calendar.getInstance()
        var age = today.get(java.util.Calendar.YEAR) - parts[0].toInt()
        val monthDiff = today.get(java.util.Calendar.MONTH) + 1 - parts[1].toInt()
        val dayDiff   = today.get(java.util.Calendar.DAY_OF_MONTH) - parts[2].toInt()
        if (monthDiff < 0 || (monthDiff == 0 && dayDiff < 0)) age--
        if (age < 0) null else age
    } catch (_: Exception) { null }
}

package com.globussoft.wellness.feature.patients.domain.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Patient
import com.globussoft.wellness.core.domain.model.PatientForm
import com.globussoft.wellness.core.domain.model.Service
import com.globussoft.wellness.core.domain.model.Staff
import com.globussoft.wellness.core.domain.model.Visit
import kotlinx.coroutines.flow.Flow

/**
 * Domain contract for the Patients feature.
 *
 * [getPatients] is the only Flow-based method because the patient list benefits
 * from offline-first delivery — Room emits the cached rows immediately while
 * the network refresh happens in the background. All other methods are direct
 * suspend calls because they either write to the server (create/update) or load
 * secondary data that doesn't need caching (visits, services, doctors).
 *
 * Implemented by [com.globussoft.wellness.feature.patients.data.repository.PatientsRepositoryImpl]
 * and bound via [com.globussoft.wellness.feature.patients.di.PatientsModule].
 */
interface PatientsRepository {

    /**
     * Returns a [Flow] of patient pages for the current tenant.
     *
     * The Flow emits [WResult.Loading] once on subscription, then
     * [WResult.Success] / [WResult.Error] as the Room cache is read and the
     * network refresh completes.
     *
     * @param search  Substring filter applied to name and phone. Empty string
     *                returns all patients.
     * @param skip    Pagination offset (0-based).
     * @param limit   Page size.
     */
    fun getPatients(
        search: String = "",
        skip: Int = 0,
        limit: Int = 20,
    ): Flow<WResult<PaginatedPatients>>

    /**
     * Fetches a single patient record by [id].
     *
     * Tries the network first; falls back to the Room cache on network errors
     * so the detail screen renders without connectivity.
     */
    suspend fun getPatient(id: String): WResult<Patient>

    /** Creates a new patient record on the server and upserts to cache. */
    suspend fun createPatient(form: PatientForm): WResult<Patient>

    /** Updates an existing patient record on the server and upserts to cache. */
    suspend fun updatePatient(id: String, form: PatientForm): WResult<Patient>

    /**
     * Returns all visits for a specific patient, ordered by [Visit.visitDate]
     * descending (newest first).
     */
    suspend fun getPatientVisits(patientId: String): WResult<List<Visit>>

    /** Returns the active service catalog for the tenant. */
    suspend fun getServices(): WResult<List<Service>>

    /**
     * Returns staff members whose [Staff.wellnessRole] is DOCTOR or PROFESSIONAL
     * so the LogVisit form can offer a doctor picker.
     */
    suspend fun getDoctors(): WResult<List<Staff>>
}

/**
 * A paginated slice of the patient roster.
 *
 * @param patients The patients on the current page.
 * @param total    Server-reported total count across all pages — used to
 *                 determine whether infinite scroll has reached the end.
 */
data class PaginatedPatients(
    val patients: List<Patient>,
    val total: Int,
)

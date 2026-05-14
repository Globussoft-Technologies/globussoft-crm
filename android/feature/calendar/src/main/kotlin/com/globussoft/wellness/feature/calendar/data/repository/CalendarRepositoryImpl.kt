package com.globussoft.wellness.feature.calendar.data.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.mapper.toDomain
import com.globussoft.wellness.core.domain.model.Location
import com.globussoft.wellness.core.domain.model.Service
import com.globussoft.wellness.core.domain.model.Staff
import com.globussoft.wellness.core.domain.model.Visit
import com.globussoft.wellness.core.domain.model.WaitlistEntry
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.model.request.CreateVisitRequest
import com.globussoft.wellness.core.network.model.request.CreateWaitlistRequest
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.calendar.domain.repository.CalendarRepository
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Production implementation of [CalendarRepository].
 *
 * All calls are network-first — the calendar is a real-time scheduling surface
 * where stale cached data would cause double-booking. Room caching is
 * intentionally omitted here; the Patients feature owns the patient cache, and
 * visit data is fetched fresh on every date change or pull-to-refresh.
 *
 * ### safeApiCall contract
 * Every function delegates to [safeApiCall] which catches connectivity errors,
 * HTTP non-2xx responses, and null bodies, mapping them all to [WResult.Error]
 * with a typed [com.globussoft.wellness.core.domain.error.DomainError].
 */
@Singleton
class CalendarRepositoryImpl @Inject constructor(
    private val api: WellnessApi,
) : CalendarRepository {

    override suspend fun getVisitsForDate(
        date: String,
        locationId: String?,
    ): WResult<List<Visit>> =
        safeApiCall { api.getVisits(date = date, locationId = locationId, skip = 0, limit = 200) }
            .mapSuccess { list -> list.map { it.toDomain() } }

    override suspend fun createVisit(request: CreateVisitRequest): WResult<Visit> =
        safeApiCall { api.createVisit(request) }
            .mapSuccess { it.toDomain() }

    override suspend fun updateVisitStatus(visitId: String, status: String): WResult<Visit> =
        safeApiCall { api.updateVisitStatus(visitId, mapOf("status" to status)) }
            .mapSuccess { it.toDomain() }

    override suspend fun getStaff(wellnessRole: String?): WResult<List<Staff>> =
        safeApiCall { api.getStaff(wellnessRole = wellnessRole) }
            .mapSuccess { list -> list.map { it.toDomain() } }

    override suspend fun getWaitlist(status: String?): WResult<List<WaitlistEntry>> =
        safeApiCall { api.getWaitlist(status = status) }
            .mapSuccess { list -> list.map { it.toDomain() } }

    override suspend fun createWaitlistEntry(request: CreateWaitlistRequest): WResult<WaitlistEntry> =
        safeApiCall { api.createWaitlistEntry(request) }
            .mapSuccess { it.toDomain() }

    override suspend fun updateWaitlistEntry(id: String, status: String): WResult<WaitlistEntry> =
        safeApiCall { api.updateWaitlistEntry(id, mapOf("status" to status)) }
            .mapSuccess { it.toDomain() }

    override suspend fun getServices(): WResult<List<Service>> =
        safeApiCall { api.getServices() }
            .mapSuccess { list -> list.filter { it.isActive }.map { it.toDomain() } }

    override suspend fun getLocations(): WResult<List<Location>> =
        safeApiCall { api.getLocations() }
            .mapSuccess { list -> list.map { it.toDomain() } }
}

// ─── Private extension ────────────────────────────────────────────────────────

/**
 * Transforms the [WResult.Success] payload while leaving [WResult.Error]
 * and [WResult.Loading] unchanged.
 */
private inline fun <T, R> WResult<T>.mapSuccess(transform: (T) -> R): WResult<R> =
    when (this) {
        is WResult.Success -> WResult.Success(transform(data))
        is WResult.Error   -> this
        WResult.Loading    -> WResult.Loading
    }

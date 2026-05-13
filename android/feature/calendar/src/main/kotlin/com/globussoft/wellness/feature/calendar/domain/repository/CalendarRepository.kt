package com.globussoft.wellness.feature.calendar.domain.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Location
import com.globussoft.wellness.core.domain.model.Service
import com.globussoft.wellness.core.domain.model.Staff
import com.globussoft.wellness.core.domain.model.Visit
import com.globussoft.wellness.core.domain.model.WaitlistEntry
import com.globussoft.wellness.core.network.model.request.CreateVisitRequest
import com.globussoft.wellness.core.network.model.request.CreateWaitlistRequest

/**
 * Repository contract for the Calendar feature.
 *
 * All methods are suspend functions returning [WResult] so the presentation
 * layer can handle Loading / Success / Error uniformly without catching
 * exceptions directly.
 */
interface CalendarRepository {

    /**
     * Returns all visits for a given calendar [date] (ISO-8601 "yyyy-MM-dd")
     * optionally filtered to a single clinic [locationId].
     */
    suspend fun getVisitsForDate(
        date: String,
        locationId: String? = null,
    ): WResult<List<Visit>>

    /** Creates a new visit / appointment record. */
    suspend fun createVisit(request: CreateVisitRequest): WResult<Visit>

    /**
     * Transitions [visitId] to [status] (one of the [VisitStatus] raw names,
     * e.g. "CONFIRMED", "COMPLETED", "CANCELLED").
     */
    suspend fun updateVisitStatus(visitId: String, status: String): WResult<Visit>

    /**
     * Returns staff members filtered by [wellnessRole].
     *
     * Defaults to "doctor,professional" to fetch both doctors and professionals
     * for column headers. Pass "doctor" alone to narrow to doctors-only dropdowns.
     */
    suspend fun getStaff(wellnessRole: String? = "doctor,professional"): WResult<List<Staff>>

    /**
     * Returns waitlist entries optionally filtered by [status] raw name
     * (e.g. "WAITING", "OFFERED"). Null returns all statuses.
     */
    suspend fun getWaitlist(status: String? = null): WResult<List<WaitlistEntry>>

    /** Creates a new waitlist entry. */
    suspend fun createWaitlistEntry(request: CreateWaitlistRequest): WResult<WaitlistEntry>

    /**
     * Updates the [status] of the waitlist entry identified by [id].
     */
    suspend fun updateWaitlistEntry(id: String, status: String): WResult<WaitlistEntry>

    /** Returns the full active service catalog. */
    suspend fun getServices(): WResult<List<Service>>

    /** Returns all clinic locations belonging to the tenant. */
    suspend fun getLocations(): WResult<List<Location>>
}

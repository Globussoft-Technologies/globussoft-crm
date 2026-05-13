package com.globussoft.wellness.feature.visits.domain.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.visits.domain.model.AttendanceData
import com.globussoft.wellness.feature.visits.domain.model.AttendanceRecord
import com.globussoft.wellness.feature.visits.domain.model.LeaveRequest
import com.globussoft.wellness.feature.visits.domain.model.PaginatedVisits
import com.globussoft.wellness.feature.visits.domain.model.StaffAttendance

/**
 * Repository interface for the Visits feature module.
 *
 * Covers three sub-domains:
 * - **Visits log** — paginated visit/appointment history with date-range filters.
 * - **Attendance** — punch-in / punch-out and 30-day history for the current user,
 *   plus a manager-level all-staff-today view.
 * - **Leave** — personal leave requests with CRUD, plus manager approve/reject.
 */
interface VisitsRepository {

    // ─── Visits log ───────────────────────────────────────────────────────────

    /**
     * Returns a paginated page of visits, optionally filtered by [from] and [to]
     * ISO-8601 date strings.
     */
    suspend fun getVisits(
        from: String?,
        to: String?,
        skip: Int,
        limit: Int,
    ): WResult<PaginatedVisits>

    // ─── Attendance ───────────────────────────────────────────────────────────

    /** Returns today's punch-in / punch-out state for the current user. */
    suspend fun getAttendanceToday(): WResult<AttendanceData>

    /** Records a punch-in for the current user. Returns the resulting record. */
    suspend fun punchIn(): WResult<AttendanceRecord>

    /** Records a punch-out for the current user. Returns the resulting record. */
    suspend fun punchOut(): WResult<AttendanceRecord>

    /**
     * Returns the last [days] days of attendance records for the current user.
     * Defaults to 30 days.
     */
    suspend fun getAttendanceHistory(days: Int = 30): WResult<List<AttendanceRecord>>

    /**
     * Returns today's attendance status for all staff members.
     * Only available to MANAGER / ADMIN roles.
     */
    suspend fun getAllStaffAttendanceToday(): WResult<List<StaffAttendance>>

    // ─── Leave ────────────────────────────────────────────────────────────────

    /**
     * Returns leave requests.
     * [myOnly] — true returns only the current user's requests; false returns all
     * (manager-level view).
     */
    suspend fun getLeaveRequests(myOnly: Boolean): WResult<List<LeaveRequest>>

    /**
     * Creates a new leave request.
     * Expected params keys: fromDate, toDate, type, reason.
     */
    suspend fun createLeaveRequest(params: Map<String, Any>): WResult<LeaveRequest>

    /** Approves the leave request identified by [id]. */
    suspend fun approveLeaveRequest(id: String): WResult<LeaveRequest>

    /** Rejects the leave request identified by [id]. */
    suspend fun rejectLeaveRequest(id: String): WResult<LeaveRequest>
}

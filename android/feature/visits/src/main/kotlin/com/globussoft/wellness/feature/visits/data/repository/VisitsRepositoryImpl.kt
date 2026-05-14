package com.globussoft.wellness.feature.visits.data.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.mapper.toDomain
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.visits.domain.model.AttendanceData
import com.globussoft.wellness.feature.visits.domain.model.AttendanceRecord
import com.globussoft.wellness.feature.visits.domain.model.LeaveRequest
import com.globussoft.wellness.feature.visits.domain.model.PaginatedVisits
import com.globussoft.wellness.feature.visits.domain.model.StaffAttendance
import com.globussoft.wellness.feature.visits.domain.repository.VisitsRepository
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Production implementation of [VisitsRepository].
 *
 * All operations are network-only (no Room cache) because visit and attendance
 * records are time-sensitive and must reflect the server's authoritative state.
 *
 * ### Endpoint map
 * - Visits:     GET  /wellness/visits
 * - Attendance: GET  /wellness/attendance/today
 *               POST /wellness/attendance/punch-in
 *               POST /wellness/attendance/punch-out
 *               GET  /wellness/attendance/history?days=N
 *               GET  /wellness/attendance/all-today
 * - Leave:      GET  /wellness/leave?myOnly=true|false
 *               POST /wellness/leave
 *               POST /wellness/leave/{id}/approve
 *               POST /wellness/leave/{id}/reject
 */
@Singleton
class VisitsRepositoryImpl @Inject constructor(
    private val api: WellnessApi,
) : VisitsRepository {

    // ─── Visits ───────────────────────────────────────────────────────────────

    override suspend fun getVisits(
        from: String?,
        to: String?,
        skip: Int,
        limit: Int,
    ): WResult<PaginatedVisits> =
        safeApiCall { api.getVisits(from = from, to = to, skip = skip, limit = limit) }
            .mapSuccess { list ->
                PaginatedVisits(
                    visits = list.map { it.toDomain() },
                    total  = list.size,
                )
            }

    // ─── Attendance ───────────────────────────────────────────────────────────

    override suspend fun getAttendanceToday(): WResult<AttendanceData> =
        safeApiCall { api.getAttendanceToday() }
            .mapSuccess { list ->
                val today = list.filterIsInstance<Map<*, *>>()
                    .maxByOrNull { (it["createdAt"] as? String) ?: "" }
                AttendanceData(
                    isClockedIn = today != null && today["clockOutAt"] == null,
                    clockInAt   = today?.get("clockInAt") as? String,
                    clockOutAt  = today?.get("clockOutAt") as? String,
                    duration    = today?.get("totalMinutes")?.let { "${(it as? Number)?.toInt() ?: 0} min" },
                )
            }

    override suspend fun punchIn(): WResult<AttendanceRecord> =
        safeApiCall { api.punchIn() }
            .mapSuccess { data -> (data as Map<*, *>).toAttendanceRecord() }

    override suspend fun punchOut(): WResult<AttendanceRecord> =
        safeApiCall { api.punchOut() }
            .mapSuccess { data -> (data as Map<*, *>).toAttendanceRecord() }

    override suspend fun getAttendanceHistory(days: Int): WResult<List<AttendanceRecord>> =
        safeApiCall { api.getAttendanceHistory() }
            .mapSuccess { list ->
                list.filterIsInstance<Map<*, *>>().map { it.toAttendanceRecord() }
            }

    override suspend fun getAllStaffAttendanceToday(): WResult<List<StaffAttendance>> =
        safeApiCall { api.getAllStaffAttendanceToday() }
            .mapSuccess { data ->
                @Suppress("UNCHECKED_CAST")
                val envelope = data as? Map<*, *> ?: return@mapSuccess emptyList()
                val byUser = envelope["byUser"] as? Map<*, *> ?: emptyMap<Any, Any>()
                byUser.values.filterIsInstance<Map<*, *>>().map { m ->
                    StaffAttendance(
                        staffName = m["name"] as? String ?: m["userId"]?.toString() ?: "",
                        status    = m["status"] as? String ?: "ABSENT",
                        clockIn   = m["clockInAt"] as? String,
                        clockOut  = m["clockOutAt"] as? String,
                        duration  = m["totalMinutes"]?.let { "${(it as? Number)?.toInt() ?: 0} min" },
                    )
                }
            }

    // ─── Leave ────────────────────────────────────────────────────────────────

    override suspend fun getLeaveRequests(myOnly: Boolean): WResult<List<LeaveRequest>> =
        safeApiCall { api.getLeaveRequests() }
            .mapSuccess { data ->
                @Suppress("UNCHECKED_CAST")
                val list = when (data) {
                    is List<*> -> data
                    is Map<*, *> -> (data["requests"] ?: data["data"]) as? List<*> ?: emptyList<Any>()
                    else -> emptyList<Any>()
                }
                list.filterIsInstance<Map<*, *>>().map { it.toLeaveRequest() }
            }

    override suspend fun createLeaveRequest(params: Map<String, Any>): WResult<LeaveRequest> =
        safeApiCall { api.createLeaveRequest(params) }
            .mapSuccess { data -> (data as Map<*, *>).toLeaveRequest() }

    override suspend fun approveLeaveRequest(id: String): WResult<LeaveRequest> =
        safeApiCall { api.approveLeaveRequest(id) }
            .mapSuccess { data -> (data as Map<*, *>).toLeaveRequest() }

    override suspend fun rejectLeaveRequest(id: String): WResult<LeaveRequest> =
        safeApiCall { api.rejectLeaveRequest(id) }
            .mapSuccess { data -> (data as Map<*, *>).toLeaveRequest() }

    // ─── Private mapping helpers ──────────────────────────────────────────────

    private fun Map<*, *>.toAttendanceRecord(): AttendanceRecord = AttendanceRecord(
        date     = this["date"] as? String ?: "",
        clockIn  = this["clockIn"] as? String,
        clockOut = this["clockOut"] as? String,
        duration = this["duration"] as? String,
        status   = this["status"] as? String ?: "PRESENT",
    )

    private fun Map<*, *>.toLeaveRequest(): LeaveRequest = LeaveRequest(
        id           = anyId(this["id"]),
        employeeName = this["employeeName"] as? String,
        fromDate     = this["fromDate"] as? String ?: "",
        toDate       = this["toDate"] as? String ?: "",
        type         = this["type"] as? String ?: "ANNUAL",
        reason       = this["reason"] as? String ?: "",
        status       = this["status"] as? String ?: "PENDING",
        createdAt    = this["createdAt"] as? String ?: "",
    )
}

private fun anyId(raw: Any?): String = when (raw) {
    is Number -> raw.toLong().toString()
    is String -> raw
    else      -> ""
}

// ─── Private extension ────────────────────────────────────────────────────────

private inline fun <T, R> WResult<T>.mapSuccess(transform: (T) -> R): WResult<R> =
    when (this) {
        is WResult.Success -> WResult.Success(transform(data))
        is WResult.Error   -> this
        WResult.Loading    -> WResult.Loading
    }

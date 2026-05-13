package com.globussoft.wellness.feature.visits.domain.model

// ─── Visits ───────────────────────────────────────────────────────────────────

/**
 * A paginated page of visits together with the server-reported total count.
 *
 * [total] reflects the full population matching the applied filters, which may
 * exceed the size of [visits] when pagination is in use.
 */
data class PaginatedVisits(
    val visits: List<com.globussoft.wellness.core.domain.model.Visit>,
    val total: Int,
)

// ─── Attendance ───────────────────────────────────────────────────────────────

/**
 * Today's attendance status for the currently signed-in user.
 *
 * [isClockedIn] — true if a punch-in has been recorded today with no punch-out.
 * [clockInAt]  — ISO-8601 timestamp of today's punch-in; null if not yet clocked in.
 * [clockOutAt] — ISO-8601 timestamp of today's punch-out; null if still clocked in.
 * [duration]   — Human-readable elapsed time string (e.g. "3h 42m"); null until clocked out.
 */
data class AttendanceData(
    val isClockedIn: Boolean,
    val clockInAt: String?,
    val clockOutAt: String?,
    val duration: String?,
)

/**
 * A single attendance record in the 30-day history table.
 *
 * [status] — "PRESENT" / "ABSENT" / "HALF_DAY" / "LEAVE"
 */
data class AttendanceRecord(
    val date: String,
    val clockIn: String?,
    val clockOut: String?,
    val duration: String?,
    val status: String,
)

/**
 * Today's attendance entry for a single staff member (MANAGER / ADMIN view).
 */
data class StaffAttendance(
    val staffName: String,
    val status: String,
    val clockIn: String?,
    val clockOut: String?,
    val duration: String?,
)

// ─── Leave ────────────────────────────────────────────────────────────────────

/**
 * A single leave request.
 *
 * [status] — "PENDING" / "APPROVED" / "REJECTED"
 * [type]   — "ANNUAL" / "SICK" / "UNPAID"
 * [employeeName] — populated in manager view; null in self-view since the app
 *                  already shows the logged-in user's own requests.
 */
data class LeaveRequest(
    val id: String,
    val employeeName: String?,
    val fromDate: String,
    val toDate: String,
    val type: String,
    val reason: String,
    val status: String,
    val createdAt: String,
)

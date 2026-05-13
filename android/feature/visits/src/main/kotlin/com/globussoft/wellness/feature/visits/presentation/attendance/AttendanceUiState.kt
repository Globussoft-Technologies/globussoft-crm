package com.globussoft.wellness.feature.visits.presentation.attendance

import com.globussoft.wellness.feature.visits.domain.model.AttendanceData
import com.globussoft.wellness.feature.visits.domain.model.AttendanceRecord
import com.globussoft.wellness.feature.visits.domain.model.StaffAttendance

/**
 * Immutable UI state for the Attendance screen.
 *
 * [todayData] drives the hero "Punch In / Punch Out" card.
 * [elapsedLabel] is updated every minute by the ViewModel's ticker when
 * [AttendanceData.isClockedIn] is true, so the elapsed time stays live.
 * [history] shows the last 30 days in a table.
 * [staffToday] is only populated (and rendered) for MANAGER / ADMIN users.
 */
data class AttendanceUiState(
    val isLoading: Boolean = false,
    val todayData: AttendanceData? = null,
    /** Formatted elapsed time string, e.g. "3h 42m". Updated every minute. */
    val elapsedLabel: String = "",
    val isPunchingIn: Boolean = false,
    val isPunchingOut: Boolean = false,
    val history: List<AttendanceRecord> = emptyList(),
    val staffToday: List<StaffAttendance> = emptyList(),
    val error: String? = null,
)

// ─── Events ───────────────────────────────────────────────────────────────────

sealed class AttendanceEvent {
    data object Refresh : AttendanceEvent()
    data object PunchIn : AttendanceEvent()
    data object PunchOut : AttendanceEvent()
}

// ─── Effects ──────────────────────────────────────────────────────────────────

sealed class AttendanceEffect {
    data class ShowSnackbar(val message: String) : AttendanceEffect()
}

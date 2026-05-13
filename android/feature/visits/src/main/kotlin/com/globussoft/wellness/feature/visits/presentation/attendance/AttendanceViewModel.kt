package com.globussoft.wellness.feature.visits.presentation.attendance

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.datastore.AuthDataStore
import com.globussoft.wellness.feature.visits.domain.repository.VisitsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject
import kotlin.math.absoluteValue

/**
 * ViewModel for the Attendance screen.
 *
 * ### Live elapsed timer
 * When [AttendanceData.isClockedIn] is true, a coroutine ticks every 60 seconds
 * and recomputes [AttendanceUiState.elapsedLabel] from the clock-in timestamp.
 * The tick job is cancelled on punch-out or when the ViewModel is cleared.
 *
 * ### Manager view
 * [AuthDataStore.userFlow] is read once to determine if the current user is a
 * MANAGER or ADMIN.  If so, [getAllStaffAttendanceToday] is called alongside
 * the personal attendance fetch.
 */
@HiltViewModel
class AttendanceViewModel @Inject constructor(
    private val repository: VisitsRepository,
    private val authDataStore: AuthDataStore,
) : ViewModel() {

    private val _state   = MutableStateFlow(AttendanceUiState())
    val state: StateFlow<AttendanceUiState> = _state.asStateFlow()

    private val _effects = Channel<AttendanceEffect>(Channel.BUFFERED)
    val effects: Flow<AttendanceEffect> = _effects.receiveAsFlow()

    private var timerJob: Job? = null

    init { loadAll() }

    fun onEvent(event: AttendanceEvent) {
        when (event) {
            is AttendanceEvent.Refresh   -> loadAll()
            is AttendanceEvent.PunchIn   -> onPunchIn()
            is AttendanceEvent.PunchOut  -> onPunchOut()
        }
    }

    override fun onCleared() {
        super.onCleared()
        timerJob?.cancel()
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    private fun loadAll() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }

            val todayResult   = repository.getAttendanceToday()
            val historyResult = repository.getAttendanceHistory(30)

            val session = authDataStore.userFlow.first()
            val isManager = session?.isManager ?: false

            when (todayResult) {
                is WResult.Success -> {
                    _state.update { it.copy(todayData = todayResult.data) }
                    if (todayResult.data.isClockedIn) startElapsedTimer(todayResult.data.clockInAt)
                }
                is WResult.Error -> {
                    val msg = todayResult.message ?: todayResult.exception.message ?: "Failed to load attendance"
                    _state.update { it.copy(error = msg) }
                    _effects.send(AttendanceEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }

            when (historyResult) {
                is WResult.Success -> _state.update { it.copy(history = historyResult.data) }
                else               -> Unit
            }

            if (isManager) {
                when (val staffResult = repository.getAllStaffAttendanceToday()) {
                    is WResult.Success -> _state.update { it.copy(staffToday = staffResult.data) }
                    else               -> Unit
                }
            }

            _state.update { it.copy(isLoading = false) }
        }
    }

    private fun onPunchIn() {
        viewModelScope.launch {
            _state.update { it.copy(isPunchingIn = true) }
            when (val result = repository.punchIn()) {
                is WResult.Success -> {
                    // Refresh today data so isClockedIn flips to true.
                    loadAll()
                    _effects.send(AttendanceEffect.ShowSnackbar("Punched in successfully"))
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Punch-in failed"
                    _state.update { it.copy(isPunchingIn = false) }
                    _effects.send(AttendanceEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun onPunchOut() {
        viewModelScope.launch {
            _state.update { it.copy(isPunchingOut = true) }
            timerJob?.cancel()
            when (val result = repository.punchOut()) {
                is WResult.Success -> {
                    loadAll()
                    _effects.send(AttendanceEffect.ShowSnackbar("Punched out successfully"))
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Punch-out failed"
                    _state.update { it.copy(isPunchingOut = false) }
                    _effects.send(AttendanceEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    /**
     * Starts (or restarts) the 60-second elapsed time ticker.
     * [clockInIso] is the ISO-8601 clock-in timestamp string.
     */
    private fun startElapsedTimer(clockInIso: String?) {
        timerJob?.cancel()
        if (clockInIso == null) return

        timerJob = viewModelScope.launch {
            while (true) {
                _state.update { it.copy(elapsedLabel = computeElapsed(clockInIso)) }
                delay(60_000L)
            }
        }
    }

    private fun computeElapsed(clockInIso: String): String = try {
        val clockInMs = parseIsoToMillis(clockInIso)
        val elapsedMs = System.currentTimeMillis() - clockInMs
        val totalMin  = (elapsedMs / 60_000L).absoluteValue
        val hours     = totalMin / 60
        val minutes   = totalMin % 60
        when {
            hours > 0 -> "${hours}h ${minutes}m"
            else      -> "${minutes}m"
        }
    } catch (_: Exception) { "" }

    /**
     * Minimal ISO-8601 parser — handles "2026-05-13T09:30:00.000Z" and
     * "2026-05-13T09:30:00+05:30" shapes without requiring the java.time API.
     */
    private fun parseIsoToMillis(iso: String): Long {
        val clean = iso.replace("Z", "+00:00")
        val parts = clean.split("T")
        val dateParts = parts[0].split("-")
        val timePart  = parts.getOrNull(1)?.substringBefore("+") ?: "00:00:00"
        val timeParts = timePart.split(":")

        @Suppress("DEPRECATION")
        val cal = java.util.GregorianCalendar(
            dateParts[0].toInt(),
            dateParts[1].toInt() - 1,
            dateParts[2].toInt(),
            timeParts[0].toInt(),
            timeParts[1].toInt(),
            timeParts.getOrNull(2)?.substringBefore(".")?.toInt() ?: 0,
        )
        return cal.timeInMillis
    }
}

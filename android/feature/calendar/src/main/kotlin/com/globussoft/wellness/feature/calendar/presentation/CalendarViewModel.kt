package com.globussoft.wellness.feature.calendar.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.network.model.request.CreateVisitRequest
import com.globussoft.wellness.core.network.model.request.CreateWaitlistRequest
import com.globussoft.wellness.feature.calendar.domain.repository.CalendarRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import javax.inject.Inject

/**
 * ViewModel for [CalendarScreen] and [WaitlistScreen].
 *
 * ### Init sequence
 * On construction the ViewModel fires a parallel load of staff + services +
 * locations (reference data that changes infrequently), then loads visits for
 * today. This keeps the calendar usable within a single round-trip to the
 * backend.
 *
 * ### Date navigation
 * Every date-change event rebuilds the ISO date string and calls
 * [loadVisitsForDate]. In-flight calls for a previous date are NOT explicitly
 * cancelled — the state update is idempotent so a late arrival from a previous
 * date just refreshes to that date's data, which never happens in practice
 * because the ViewModel is lifecycle-scoped.
 *
 * ### New-visit submission
 * The modal state holds all form fields. On [CalendarEvent.SubmitNewVisit] the
 * ViewModel validates that the doctor, service, and patient are all set before
 * calling [CalendarRepository.createVisit]. On success it dismisses the modal,
 * sends a snackbar effect, and refreshes the calendar for the current date.
 */
@HiltViewModel
class CalendarViewModel @Inject constructor(
    private val repository: CalendarRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(CalendarUiState())
    val state: StateFlow<CalendarUiState> = _state.asStateFlow()

    private val _effects = Channel<CalendarEffect>(Channel.BUFFERED)
    val effects: Flow<CalendarEffect> = _effects.receiveAsFlow()

    private val isoDateFormatter = DateTimeFormatter.ISO_LOCAL_DATE

    init {
        loadReferenceDataThenVisits()
    }

    // ─── Public event dispatcher ──────────────────────────────────────────────

    fun onEvent(event: CalendarEvent) {
        when (event) {
            is CalendarEvent.DateChanged        -> onDateChanged(event.date)
            is CalendarEvent.PreviousDay        -> onPreviousDay()
            is CalendarEvent.NextDay            -> onNextDay()
            is CalendarEvent.Today              -> onToday()
            is CalendarEvent.SelectLocation     -> onSelectLocation(event.locationId)
            is CalendarEvent.ToggleShowAll      -> onToggleShowAll()
            is CalendarEvent.OpenNewVisitModal  -> onOpenNewVisitModal(event.doctorId, event.hour)
            is CalendarEvent.CloseNewVisitModal -> onCloseNewVisitModal()
            is CalendarEvent.ModalFieldChanged  -> onModalFieldChanged(event.field, event.value)
            is CalendarEvent.SubmitNewVisit     -> onSubmitNewVisit()
            is CalendarEvent.ChangeVisitStatus  -> onChangeVisitStatus(event.visitId, event.newStatus)
            is CalendarEvent.ToggleWaitlist     -> onToggleWaitlist()
            is CalendarEvent.Refresh            -> onRefresh()
        }
    }

    // ─── Init ─────────────────────────────────────────────────────────────────

    /**
     * Loads staff, services, and locations in parallel, then triggers an initial
     * visit load for today.
     */
    private fun loadReferenceDataThenVisits() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }

            val staffDeferred     = async { repository.getStaff() }
            val servicesDeferred  = async { repository.getServices() }
            val locationsDeferred = async { repository.getLocations() }

            val staffResult     = staffDeferred.await()
            val servicesResult  = servicesDeferred.await()
            val locationsResult = locationsDeferred.await()

            _state.update { current ->
                current.copy(
                    staff     = if (staffResult is WResult.Success) staffResult.data else current.staff,
                    services  = if (servicesResult is WResult.Success) servicesResult.data else current.services,
                    locations = if (locationsResult is WResult.Success) locationsResult.data else current.locations,
                )
            }

            loadVisitsForDate(_state.value.selectedDate)
        }
    }

    // ─── Date navigation ──────────────────────────────────────────────────────

    private fun onDateChanged(date: LocalDate) {
        _state.update { it.copy(selectedDate = date) }
        loadVisitsForDate(date)
    }

    private fun onPreviousDay() {
        val newDate = _state.value.selectedDate.minusDays(1)
        _state.update { it.copy(selectedDate = newDate) }
        loadVisitsForDate(newDate)
    }

    private fun onNextDay() {
        val newDate = _state.value.selectedDate.plusDays(1)
        _state.update { it.copy(selectedDate = newDate) }
        loadVisitsForDate(newDate)
    }

    private fun onToday() {
        val today = LocalDate.now()
        _state.update { it.copy(selectedDate = today) }
        loadVisitsForDate(today)
    }

    private fun loadVisitsForDate(date: LocalDate) {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            val dateStr = date.format(isoDateFormatter)
            when (val result = repository.getVisitsForDate(dateStr, _state.value.selectedLocationId)) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, visits = result.data) }
                is WResult.Error   -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to load visits"
                    _state.update { it.copy(isLoading = false, error = msg) }
                }
                WResult.Loading    -> Unit
            }
        }
    }

    // ─── Location filter ──────────────────────────────────────────────────────

    private fun onSelectLocation(locationId: String?) {
        _state.update { it.copy(selectedLocationId = locationId) }
        loadVisitsForDate(_state.value.selectedDate)
    }

    // ─── Show All toggle ──────────────────────────────────────────────────────

    private fun onToggleShowAll() {
        _state.update { it.copy(showAllPractitioners = !it.showAllPractitioners) }
    }

    // ─── New visit modal ──────────────────────────────────────────────────────

    private fun onOpenNewVisitModal(doctorId: String?, hour: Int?) {
        _state.update { current ->
            current.copy(
                newVisitModal = NewVisitModalState(
                    selectedDoctorId = doctorId ?: "",
                ),
            )
        }
        // Load waitlist for the "from waitlist" toggle if not already loaded.
        if (_state.value.waitlistEntries.isEmpty()) {
            loadWaitlist()
        }
    }

    private fun onCloseNewVisitModal() {
        _state.update { it.copy(newVisitModal = null) }
    }

    private fun onModalFieldChanged(field: String, value: String) {
        _state.update { current ->
            val modal = current.newVisitModal ?: return@update current
            val updated = when (field) {
                "doctorId"      -> modal.copy(selectedDoctorId = value)
                "serviceId"     -> modal.copy(selectedServiceId = value)
                "patientId"     -> modal.copy(selectedPatientId = value)
                "patientName"   -> modal.copy(patientName = value)
                "patientPhone"  -> modal.copy(patientPhone = value)
                "bookingType"   -> modal.copy(bookingType = value)
                "notes"         -> modal.copy(notes = value)
                "isNewPatient"  -> modal.copy(isNewPatient = value == "true")
                "fromWaitlistId" -> modal.copy(fromWaitlistId = value.ifBlank { null })
                else            -> modal
            }
            current.copy(newVisitModal = updated)
        }
    }

    private fun onSubmitNewVisit() {
        val modal = _state.value.newVisitModal ?: return
        val currentDate = _state.value.selectedDate

        // Validation
        if (modal.selectedDoctorId.isBlank()) {
            _state.update { it.copy(newVisitModal = modal.copy(error = "Please select a doctor")) }
            return
        }
        if (modal.selectedServiceId.isBlank()) {
            _state.update { it.copy(newVisitModal = modal.copy(error = "Please select a service")) }
            return
        }
        if (modal.isNewPatient && modal.patientName.isBlank()) {
            _state.update { it.copy(newVisitModal = modal.copy(error = "Please enter patient name")) }
            return
        }
        if (!modal.isNewPatient && modal.fromWaitlistId.isNullOrBlank()) {
            _state.update { it.copy(newVisitModal = modal.copy(error = "Please select a waitlist patient")) }
            return
        }

        viewModelScope.launch {
            _state.update { it.copy(newVisitModal = it.newVisitModal?.copy(isSubmitting = true)) }

            // When promoting from waitlist, mark the entry as BOOKED first.
            if (!modal.isNewPatient && !modal.fromWaitlistId.isNullOrBlank()) {
                when (val patchResult = repository.updateWaitlistEntry(modal.fromWaitlistId, "BOOKED")) {
                    is WResult.Error -> {
                        val msg = patchResult.message ?: patchResult.exception.message ?: "Failed to update waitlist entry"
                        _state.update { it.copy(newVisitModal = it.newVisitModal?.copy(isSubmitting = false, error = msg)) }
                        return@launch
                    }
                    else -> Unit
                }
                // Remove the promoted entry from the local waitlist list.
                _state.update { current ->
                    current.copy(waitlistEntries = current.waitlistEntries.filter { it.id != modal.fromWaitlistId })
                }
            }

            // Build the visit date at 09:00 IST for the selected day.
            val visitDate = "${currentDate.format(isoDateFormatter)}T09:00:00.000Z"

            val request = CreateVisitRequest(
                patientId         = if (modal.isNewPatient) "" else modal.selectedPatientId,
                doctorId          = modal.selectedDoctorId,
                serviceId         = modal.selectedServiceId,
                locationId        = _state.value.selectedLocationId,
                visitDate         = visitDate,
                bookingType       = modal.bookingType,
                notes             = modal.notes.ifBlank { null },
                travelTimeMinutes = null,
            )

            when (val result = repository.createVisit(request)) {
                is WResult.Success -> {
                    _state.update { it.copy(newVisitModal = null) }
                    val snackMsg = if (!modal.isNewPatient) "Waitlist patient booked successfully" else "Visit booked successfully"
                    _effects.send(CalendarEffect.ShowSnackbar(snackMsg))
                    loadVisitsForDate(currentDate)
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to create visit"
                    _state.update { it.copy(newVisitModal = it.newVisitModal?.copy(isSubmitting = false, error = msg)) }
                }
                WResult.Loading -> Unit
            }
        }
    }

    // ─── Visit status change ──────────────────────────────────────────────────

    private fun onChangeVisitStatus(visitId: String, newStatus: String) {
        viewModelScope.launch {
            when (val result = repository.updateVisitStatus(visitId, newStatus)) {
                is WResult.Success -> {
                    // Update the visit in-place to avoid a full reload.
                    _state.update { current ->
                        val updated = current.visits.map { v ->
                            if (v.id == visitId) result.data else v
                        }
                        current.copy(visits = updated)
                    }
                    _effects.send(CalendarEffect.ShowSnackbar("Visit status updated"))
                }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to update status"
                    _effects.send(CalendarEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    // ─── Waitlist ─────────────────────────────────────────────────────────────

    private fun onToggleWaitlist() {
        val willShow = !_state.value.showWaitlist
        _state.update { it.copy(showWaitlist = willShow) }
        if (willShow) loadWaitlist()
    }

    private fun loadWaitlist() {
        viewModelScope.launch {
            when (val result = repository.getWaitlist()) {
                is WResult.Success -> _state.update { it.copy(waitlistEntries = result.data) }
                is WResult.Error   -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to load waitlist"
                    _effects.send(CalendarEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }

    // ─── Refresh ──────────────────────────────────────────────────────────────

    private fun onRefresh() {
        _state.update { it.copy(error = null) }
        loadVisitsForDate(_state.value.selectedDate)
        if (_state.value.showWaitlist) loadWaitlist()
    }
}

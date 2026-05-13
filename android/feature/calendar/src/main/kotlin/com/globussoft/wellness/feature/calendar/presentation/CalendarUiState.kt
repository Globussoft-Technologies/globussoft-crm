package com.globussoft.wellness.feature.calendar.presentation

import com.globussoft.wellness.core.domain.model.Location
import com.globussoft.wellness.core.domain.model.Service
import com.globussoft.wellness.core.domain.model.Staff
import com.globussoft.wellness.core.domain.model.Visit
import com.globussoft.wellness.core.domain.model.WaitlistEntry
import java.time.LocalDate

// ─── UI State ─────────────────────────────────────────────────────────────────

/**
 * Immutable snapshot of the Calendar screen state managed by [CalendarViewModel].
 *
 * All mutation goes through [CalendarEvent] dispatched to the ViewModel; the
 * screen holds a read-only StateFlow<CalendarUiState>.
 *
 * @param isLoading             True while a network operation is in flight.
 * @param selectedDate          Currently displayed calendar date.
 * @param visits                Visits fetched for [selectedDate].
 * @param staff                 All staff members for practitioner column headers.
 * @param services              Full service catalog for dropdowns.
 * @param locations             All clinic locations for the location filter.
 * @param selectedLocationId    Null means "all locations".
 * @param showAllPractitioners  True = show every staff column; false = only
 *                              practitioners with ≥1 visit that day.
 * @param error                 Non-null error message shown in the UI when set.
 * @param newVisitModal         Non-null when the new-visit bottom sheet is open.
 * @param waitlistEntries       Waitlist records shown in the waitlist panel.
 * @param showWaitlist          True when the waitlist side-panel is visible.
 * @param holidayName           Non-null holiday name shown as a banner at the top.
 */
data class CalendarUiState(
    val isLoading: Boolean = false,
    val selectedDate: LocalDate = LocalDate.now(),
    val visits: List<Visit> = emptyList(),
    val staff: List<Staff> = emptyList(),
    val services: List<Service> = emptyList(),
    val locations: List<Location> = emptyList(),
    val selectedLocationId: String? = null,
    val showAllPractitioners: Boolean = false,
    val error: String? = null,
    val newVisitModal: NewVisitModalState? = null,
    val waitlistEntries: List<WaitlistEntry> = emptyList(),
    val showWaitlist: Boolean = false,
    val holidayName: String? = null,
)

/**
 * Ephemeral state owned exclusively by the new-visit bottom sheet.
 *
 * Separated from [CalendarUiState] to keep the flat state manageable and to
 * allow the sheet to reset cleanly when dismissed.
 *
 * @param isNewPatient   True = manual name/phone entry; false = pick from waitlist.
 * @param fromWaitlistId Non-null when booking is triggered from a specific waitlist row.
 */
data class NewVisitModalState(
    val selectedDoctorId: String = "",
    val selectedServiceId: String = "",
    val selectedPatientId: String = "",
    val patientName: String = "",
    val patientPhone: String = "",
    val bookingType: String = "CLINIC_VISIT",
    val notes: String = "",
    val isNewPatient: Boolean = true,
    val isSubmitting: Boolean = false,
    val fromWaitlistId: String? = null,
    val error: String? = null,
)

// ─── Events ───────────────────────────────────────────────────────────────────

/**
 * Exhaustive set of user-initiated events on the Calendar screen.
 *
 * All events are dispatched via [CalendarViewModel.onEvent] so the composable
 * layer stays event-only and never writes state directly.
 */
sealed class CalendarEvent {

    /** User tapped a specific date in a date picker or mini-calendar. */
    data class DateChanged(val date: LocalDate) : CalendarEvent()

    /** User pressed the left chevron to step back one day. */
    data object PreviousDay : CalendarEvent()

    /** User pressed the right chevron to advance one day. */
    data object NextDay : CalendarEvent()

    /** User pressed the "Today" button to jump to today. */
    data object Today : CalendarEvent()

    /** User selected a location from the location filter dropdown. */
    data class SelectLocation(val locationId: String?) : CalendarEvent()

    /**
     * Toggles the "Show All" practitioner-column visibility mode.
     * When false, only practitioners with visits that day are shown.
     */
    data object ToggleShowAll : CalendarEvent()

    /**
     * Opens the new-visit bottom sheet.
     *
     * @param doctorId Pre-selects the doctor when the user tapped an empty
     *                 slot in a practitioner column.
     * @param hour     Pre-selects the hour slot (0–23).
     */
    data class OpenNewVisitModal(
        val doctorId: String? = null,
        val hour: Int? = null,
    ) : CalendarEvent()

    /** Closes the new-visit bottom sheet without saving. */
    data object CloseNewVisitModal : CalendarEvent()

    /**
     * Updates a single field in the new-visit modal form by [field] name.
     *
     * Recognised field names: "doctorId", "serviceId", "patientId",
     * "patientName", "patientPhone", "bookingType", "notes",
     * "isNewPatient" (value "true"/"false"), "fromWaitlistId".
     */
    data class ModalFieldChanged(val field: String, val value: String) : CalendarEvent()

    /** User pressed the submit button inside the new-visit modal. */
    data object SubmitNewVisit : CalendarEvent()

    /** User chose a new [newStatus] for an existing [visitId]. */
    data class ChangeVisitStatus(val visitId: String, val newStatus: String) : CalendarEvent()

    /** Toggles the waitlist side-panel open/closed. */
    data object ToggleWaitlist : CalendarEvent()

    /** Pull-to-refresh or an explicit refresh button press. */
    data object Refresh : CalendarEvent()
}

// ─── Effects ─────────────────────────────────────────────────────────────────

/**
 * One-shot side-effects delivered to the UI via a Channel<CalendarEffect>.
 *
 * Unlike state, effects are consumed exactly once — they fire-and-forget
 * navigation or ephemeral UI feedback.
 */
sealed class CalendarEffect {

    /** Navigate to the patient detail screen for [patientId]. */
    data class NavigateToPatient(val patientId: String) : CalendarEffect()

    /** Show a transient snackbar with [message]. */
    data class ShowSnackbar(val message: String) : CalendarEffect()
}

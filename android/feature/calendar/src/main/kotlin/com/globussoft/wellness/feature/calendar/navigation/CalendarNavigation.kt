package com.globussoft.wellness.feature.calendar.navigation

import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import com.globussoft.wellness.feature.calendar.presentation.CalendarScreen
import com.globussoft.wellness.feature.calendar.presentation.WaitlistScreen

/**
 * Destination route constants for the calendar feature graph.
 *
 * Both routes share the same [CalendarViewModel] instance because
 * the Waitlist screen consumes the same repository data (visits, staff,
 * services) already loaded by the Calendar screen. Hilt scopes the ViewModel
 * to the nav graph's back-stack entry, so navigating calendar → waitlist
 * and back retains the loaded state without an extra network round-trip.
 */
object CalendarDestinations {
    const val Calendar = "calendar"
    const val Waitlist = "waitlist"
}

/**
 * Registers the calendar feature's composable destinations into the calling
 * [NavGraphBuilder].
 *
 * ### Route: `"calendar"` ([CalendarDestinations.Calendar])
 * Renders [CalendarScreen]. A visit card tap forwards [patientId] to the
 * provided [onNavigateToPatient] lambda so the host nav graph can push the
 * patient-detail route without the calendar feature depending on the patients
 * module directly.
 *
 * ### Route: `"waitlist"` ([CalendarDestinations.Waitlist])
 * Renders [WaitlistScreen]. Shares the [CalendarViewModel] with the calendar
 * route via `hiltViewModel()` scoped to the same back-stack entry.
 *
 * @param navController    Host nav controller for cross-feature navigation.
 * @param onNavigateToPatient Called when the user taps a visit card; receives
 *                           the patient's id string.
 */
fun NavGraphBuilder.calendarGraph(
    navController: NavController,
    onNavigateToPatient: (String) -> Unit = { patientId ->
        navController.navigate("patients/$patientId")
    },
) {
    composable(route = CalendarDestinations.Calendar) {
        CalendarScreen(
            viewModel           = hiltViewModel(),
            onNavigateToPatient = onNavigateToPatient,
        )
    }

    composable(route = CalendarDestinations.Waitlist) {
        WaitlistScreen(
            viewModel = hiltViewModel(),
        )
    }
}

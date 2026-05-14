package com.globussoft.wellness.feature.visits.navigation

import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.hilt.navigation.compose.hiltViewModel
import com.globussoft.wellness.feature.visits.presentation.attendance.AttendanceScreen
import com.globussoft.wellness.feature.visits.presentation.leave.LeaveScreen
import com.globussoft.wellness.feature.visits.presentation.visits.VisitsScreen

/**
 * Route constants for the visits feature graph.
 *
 * Referenced by the app-level navigation graph and any cross-graph navigation
 * call sites (e.g. a deep-link from the dashboard's "Today's visits" card).
 */
object VisitsDestinations {
    const val VisitsLog  = "visits"
    const val Attendance = "attendance"
    const val Leave      = "leave"
}

/**
 * Registers the three visits-feature composable destinations into the caller's
 * [NavGraphBuilder].
 *
 * ### Routes
 * - `"visits"` → [VisitsScreen] — paginated visit log with date-range filter.
 *   Tapping a row navigates to `patients/{patientId}` via [NavController].
 * - `"attendance"` → [AttendanceScreen] — punch-in / punch-out + 30-day history
 *   + all-staff-today (manager/admin only).
 * - `"leave"` → [LeaveScreen] — personal leave CRUD + manager approve/reject.
 *
 * @param navController Shared nav controller used to forward navigation effects
 *                      (e.g. navigate to the patient detail screen).
 */
fun NavGraphBuilder.visitsGraph(navController: NavController) {
    composable(route = VisitsDestinations.VisitsLog) {
        VisitsScreen(
            viewModel           = hiltViewModel(),
            onNavigateToPatient = { patientId ->
                navController.navigate("patients/$patientId")
            },
        )
    }

    composable(route = VisitsDestinations.Attendance) {
        AttendanceScreen(
            onNavigateBack = { navController.popBackStack() },
            viewModel      = hiltViewModel(),
        )
    }

    composable(route = VisitsDestinations.Leave) {
        LeaveScreen(
            onNavigateBack = { navController.popBackStack() },
            viewModel      = hiltViewModel(),
        )
    }
}

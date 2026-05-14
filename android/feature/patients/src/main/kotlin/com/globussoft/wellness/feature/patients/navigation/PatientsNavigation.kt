package com.globussoft.wellness.feature.patients.navigation

import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavType
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import androidx.hilt.navigation.compose.hiltViewModel
import com.globussoft.wellness.feature.patients.presentation.detail.PatientDetailScreen
import com.globussoft.wellness.feature.patients.presentation.list.PatientsListScreen

/**
 * Destination route constants for the patients feature graph.
 *
 * These string constants are the single source of truth for route definitions;
 * all navigation call sites (NavController.navigate, back-stack logic) should
 * reference these instead of inlining raw strings.
 */
object PatientsDestinations {
    const val PatientsList = "patients"
    const val PatientDetail = "patients/{patientId}"

    /** Builds the concrete [PatientDetail] route string for navigation. */
    fun patientDetail(patientId: String) = "patients/$patientId"
}

/**
 * Registers the patients feature's composable destinations into the calling
 * [NavGraphBuilder].
 *
 * ### Route: `"patients"` ([PatientsDestinations.PatientsList])
 * Renders [PatientsListScreen] which adapts between a single-pane list (compact)
 * and an [AdaptiveTwoPaneLayout] side-by-side view (tablet expanded). On compact
 * screens, selecting a patient navigates to the detail route.
 *
 * ### Route: `"patients/{patientId}"` ([PatientsDestinations.PatientDetail])
 * Renders [PatientDetailScreen] for a specific patient. The `patientId` argument
 * is extracted from the back-stack entry and passed to the ViewModel via
 * [SavedStateHandle].
 *
 * @param navController Used to forward navigation events across the graph.
 *  *                        the adaptive two-pane behaviour in [PatientsListScreen].
 */
fun NavGraphBuilder.patientsGraph(
    navController: NavController,
) {
    composable(route = PatientsDestinations.PatientsList) {
        PatientsListScreen(
            onNavigateToDetail = { patientId ->
                navController.navigate(PatientsDestinations.patientDetail(patientId))
            },
        )
    }

    composable(
        route     = PatientsDestinations.PatientDetail,
        arguments = listOf(
            navArgument("patientId") { type = NavType.StringType },
        ),
    ) { backStackEntry ->
        val patientId = backStackEntry.arguments?.getString("patientId")
            ?: return@composable

        PatientDetailScreen(
            patientId  = patientId,
            onBack     = { navController.popBackStack() },
            showBackButton = true,
        )
    }
}

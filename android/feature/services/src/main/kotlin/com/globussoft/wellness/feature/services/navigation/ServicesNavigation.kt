package com.globussoft.wellness.feature.services.navigation

import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import com.globussoft.wellness.feature.services.presentation.ServicesScreen

/**
 * Destination route constants for the services feature graph.
 */
object ServicesDestinations {
    const val Services = "services"
}

/**
 * Registers the services feature's composable destination into the calling
 * [NavGraphBuilder].
 *
 * ### Route: `"services"` ([ServicesDestinations.Services])
 * Renders [ServicesScreen]. The screen is self-contained — it requires no
 * cross-feature navigation callbacks because service management does not
 * navigate to patient detail or other feature graphs.
 *
 * @param navController Host nav controller (reserved for future cross-feature
 *                      navigation if needed, e.g. tapping a treatment plan row
 *                      to navigate to the patient detail screen).
 */
fun NavGraphBuilder.servicesGraph(
    navController: NavController,
) {
    composable(route = ServicesDestinations.Services) {
        ServicesScreen(
            viewModel = hiltViewModel(),
        )
    }
}

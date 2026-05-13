package com.globussoft.wellness.feature.reports.navigation

import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import com.globussoft.wellness.feature.reports.presentation.ReportsScreen

/**
 * Destination route constants for the reports feature graph.
 *
 * Referenced by the app-level wellness navigation graph and by Quick Action
 * cards that deep-link into the reports screen.
 */
object ReportsDestinations {
    const val Reports = "reports"
}

/**
 * Registers the reports feature's composable destination into the calling
 * [NavGraphBuilder].
 *
 * [ReportsScreen] is self-contained and injects its own ViewModel via Hilt;
 * no parameters are required from the navigation graph.
 */
fun NavGraphBuilder.reportsGraph() {
    composable(ReportsDestinations.Reports) {
        ReportsScreen()
    }
}

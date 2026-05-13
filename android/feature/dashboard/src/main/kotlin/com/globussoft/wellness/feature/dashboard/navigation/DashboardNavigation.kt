package com.globussoft.wellness.feature.dashboard.navigation

import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import com.globussoft.wellness.feature.dashboard.presentation.dashboard.DashboardScreen
import com.globussoft.wellness.feature.dashboard.presentation.recommendations.RecommendationsScreen

/**
 * Destination route constants for the dashboard feature graph.
 *
 * These strings are referenced by the app-level navigation graph to build
 * deep-link URIs and by quick-action cards to navigate across feature modules
 * without coupling to internal screen classes.
 */
object DashboardDestinations {
    const val Dashboard       = "dashboard"
    const val Recommendations = "recommendations"
}

/**
 * Registers the dashboard feature's composable destinations into the calling
 * [NavGraphBuilder].
 *
 * Both destinations are added at the same nesting level as the caller's graph
 * (flat registration) rather than inside a nested `navigation {}` block.  This
 * matches the project convention for feature modules that don't own a dedicated
 * sub-graph root — the wellness NavGraph in `:app` owns the root.
 *
 * @param navController Used by [DashboardScreen] to forward quick-action taps
 *                      to destinations in other feature modules.
 */
fun NavGraphBuilder.dashboardGraph(navController: NavController) {
    composable(DashboardDestinations.Dashboard) {
        DashboardScreen(
            onNavigate = { route -> navController.navigate(route) },
        )
    }
    composable(DashboardDestinations.Recommendations) {
        RecommendationsScreen()
    }
}

package com.globussoft.wellness.navigation

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.rememberNavController
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.core.domain.model.UserRole
import com.globussoft.wellness.core.domain.model.WellnessRole
import com.globussoft.wellness.feature.auth.navigation.authGraph
import com.globussoft.wellness.feature.auth.navigation.AUTH_GRAPH_ROUTE
import com.globussoft.wellness.feature.dashboard.navigation.dashboardGraph
import com.globussoft.wellness.feature.patients.navigation.patientsGraph
import com.globussoft.wellness.feature.calendar.navigation.calendarGraph
import com.globussoft.wellness.feature.services.navigation.servicesGraph
import com.globussoft.wellness.feature.finance.navigation.financeGraph
import com.globussoft.wellness.feature.visits.navigation.visitsGraph
import com.globussoft.wellness.feature.reports.navigation.reportsGraph
import com.globussoft.wellness.feature.telecaller.navigation.telecallerGraph
import com.globussoft.wellness.feature.admin.navigation.adminGraph
import com.globussoft.wellness.feature.settings.navigation.settingsGraph

const val MAIN_GRAPH_ROUTE = "main"

@Composable
fun WellnessNavHost(
    windowSizeClass: WindowSizeClass,
    isLoggedIn: Boolean,
    userSession: UserSession?,
    modifier: Modifier = Modifier,
    navController: NavHostController = rememberNavController()
) {
    val startDestination = if (isLoggedIn) MAIN_GRAPH_ROUTE else AUTH_GRAPH_ROUTE

    NavHost(
        navController = navController,
        startDestination = startDestination,
        modifier = modifier
    ) {
        authGraph(
            onLoginSuccess = {
                navController.navigate(MAIN_GRAPH_ROUTE) {
                    popUpTo(AUTH_GRAPH_ROUTE) { inclusive = true }
                }
            }
        )

        // Main shell with adaptive scaffold + nested feature graphs
        mainGraph(
            navController = navController,
            windowSizeClass = windowSizeClass,
            userSession = userSession,
            onLogout = {
                navController.navigate(AUTH_GRAPH_ROUTE) {
                    popUpTo(MAIN_GRAPH_ROUTE) { inclusive = true }
                }
            }
        )
    }
}

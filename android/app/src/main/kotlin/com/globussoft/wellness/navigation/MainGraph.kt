package com.globussoft.wellness.navigation

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.navigation
import androidx.navigation.compose.rememberNavController
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.feature.admin.navigation.adminGraph
import com.globussoft.wellness.feature.calendar.navigation.calendarGraph
import com.globussoft.wellness.feature.dashboard.navigation.dashboardGraph
import com.globussoft.wellness.feature.finance.navigation.financeGraph
import com.globussoft.wellness.feature.patients.navigation.patientsGraph
import com.globussoft.wellness.feature.reports.navigation.reportsGraph
import com.globussoft.wellness.feature.services.navigation.servicesGraph
import com.globussoft.wellness.feature.settings.navigation.settingsGraph
import com.globussoft.wellness.feature.telecaller.navigation.telecallerGraph
import com.globussoft.wellness.feature.visits.navigation.visitsGraph

fun NavGraphBuilder.mainGraph(
    navController: NavHostController,
    windowSizeClass: WindowSizeClass,
    userSession: UserSession?,
    onLogout: () -> Unit
) {
    navigation(
        route = MAIN_GRAPH_ROUTE,
        startDestination = "main_shell"
    ) {
        composable("main_shell") {
            val innerNavController = rememberNavController()
            val navBackStackEntry by innerNavController.currentBackStackEntryAsState()
            val currentRoute = navBackStackEntry?.destination?.route

            val isExpandedWidth = windowSizeClass.widthSizeClass == WindowWidthSizeClass.Expanded

            if (isExpandedWidth) {
                Row(Modifier.fillMaxSize()) {
                    WellnessNavigationRail(
                        currentRoute = currentRoute,
                        userSession = userSession,
                        onNavigate = { route ->
                            innerNavController.navigate(route) {
                                popUpTo(innerNavController.graph.startDestinationId) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        }
                    )
                    InnerNavHost(
                        navController = innerNavController,
                        windowSizeClass = windowSizeClass,
                        userSession = userSession,
                        onLogout = onLogout,
                        modifier = Modifier.weight(1f)
                    )
                }
            } else {
                Scaffold(
                    bottomBar = {
                        WellnessBottomBar(
                            currentRoute = currentRoute,
                            userSession = userSession,
                            onNavigate = { route ->
                                innerNavController.navigate(route) {
                                    popUpTo(innerNavController.graph.startDestinationId) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            }
                        )
                    }
                ) { padding ->
                    InnerNavHost(
                        navController = innerNavController,
                        windowSizeClass = windowSizeClass,
                        userSession = userSession,
                        onLogout = onLogout,
                        modifier = Modifier.padding(padding)
                    )
                }
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun InnerNavHost(
    navController: NavHostController,
    windowSizeClass: WindowSizeClass,
    userSession: UserSession?,
    onLogout: () -> Unit,
    modifier: Modifier = Modifier
) {
    NavHost(
        navController = navController,
        startDestination = "dashboard",
        modifier = modifier
    ) {
        dashboardGraph(navController)
        patientsGraph(navController, windowSizeClass)
        calendarGraph(navController)
        servicesGraph(navController)
        financeGraph(navController, userSession)
        visitsGraph(navController)
        reportsGraph(navController, userSession)
        telecallerGraph(navController, userSession)
        adminGraph(navController, userSession)
        settingsGraph(navController, userSession, onLogout)
    }
}

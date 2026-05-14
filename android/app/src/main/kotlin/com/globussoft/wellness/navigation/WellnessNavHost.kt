package com.globussoft.wellness.navigation

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.rememberNavController
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.feature.auth.navigation.authGraph
import com.globussoft.wellness.feature.auth.navigation.AUTH_GRAPH_ROUTE

const val MAIN_GRAPH_ROUTE = "main"

@Composable
fun WellnessNavHost(
    isLoggedIn: Boolean,
    userSession: UserSession?,
    modifier: Modifier = Modifier,
    navController: NavHostController = rememberNavController(),
) {
    val startDestination = if (isLoggedIn) MAIN_GRAPH_ROUTE else AUTH_GRAPH_ROUTE

    NavHost(
        navController    = navController,
        startDestination = startDestination,
        modifier         = modifier,
    ) {
        authGraph(
            onLoginSuccess = {
                navController.navigate(MAIN_GRAPH_ROUTE) {
                    popUpTo(AUTH_GRAPH_ROUTE) { inclusive = true }
                }
            }
        )
        mainGraph(
            navController = navController,
            userSession   = userSession,
            onLogout      = {
                navController.navigate(AUTH_GRAPH_ROUTE) {
                    popUpTo(MAIN_GRAPH_ROUTE) { inclusive = true }
                }
            }
        )
    }
}

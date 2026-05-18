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
    val vertical = userSession?.vertical ?: "wellness"

    val onLogout: () -> Unit = {
        navController.navigate(AUTH_GRAPH_ROUTE) {
            popUpTo(MAIN_GRAPH_ROUTE) { inclusive = true }
        }
    }

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

        // Route to the correct main graph based on tenant vertical.
        // "generic" → Generic CRM experience (indigo theme, CRM sidebar).
        // "wellness" (default) → existing Wellness CRM experience.
        if (vertical == "generic") {
            genericCrmMainGraph(
                navController = navController,
                userSession   = userSession,
                onLogout      = onLogout,
            )
        } else {
            mainGraph(
                navController = navController,
                userSession   = userSession,
                onLogout      = onLogout,
            )
        }
    }
}

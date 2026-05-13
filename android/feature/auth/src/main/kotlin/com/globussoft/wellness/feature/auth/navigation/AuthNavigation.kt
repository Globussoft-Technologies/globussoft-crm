package com.globussoft.wellness.feature.auth.navigation

import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.navigation
import com.globussoft.wellness.feature.auth.presentation.LoginScreen

/** Top-level route that owns the entire authentication sub-graph. */
const val AUTH_GRAPH_ROUTE = "auth"

/**
 * Registers the authentication nested navigation graph.
 *
 * Currently the graph contains a single destination ("login"), but the nested
 * `navigation {}` wrapper leaves room to add password-reset, OTP-verification,
 * and SSO picker routes without touching the parent graph's declaration.
 *
 * @param onLoginSuccess Callback invoked when the user successfully authenticates;
 *                       the parent graph should navigate to the main app graph.
 */
fun NavGraphBuilder.authGraph(onLoginSuccess: () -> Unit) {
    navigation(
        route            = AUTH_GRAPH_ROUTE,
        startDestination = AuthDestinations.Login,
    ) {
        composable(AuthDestinations.Login) {
            LoginScreen(onLoginSuccess = onLoginSuccess)
        }
    }
}

/**
 * Destination route strings within the auth graph.
 *
 * Centralising them here prevents scattered magic strings and makes refactoring
 * safe — only this file needs to change if a route is renamed.
 */
internal object AuthDestinations {
    const val Login = "login"
}

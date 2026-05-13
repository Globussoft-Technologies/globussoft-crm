package com.globussoft.wellness.feature.settings.navigation

import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.feature.settings.presentation.SettingsScreen

/**
 * Destination route constants for the settings feature graph.
 */
object SettingsDestinations {
    const val Settings = "settings"
}

/**
 * Registers the settings feature's composable destination into the calling
 * [NavGraphBuilder].
 *
 * @param navController Used to build the [onLogout] callback that replaces the
 *                      back stack with the login screen after sign-out.
 * @param userSession   The current session; passed to [SettingsScreen] as a
 *                      pre-loaded fallback while the ViewModel's DataStore flow
 *                      is still warming up.
 * @param onLogout      Invoked when the user confirms sign-out.  The caller
 *                      (app-level navigation graph) should clear the back stack
 *                      and navigate to the login route.
 */
fun NavGraphBuilder.settingsGraph(
    navController: NavController,
    userSession: UserSession?,
    onLogout: () -> Unit,
) {
    composable(SettingsDestinations.Settings) {
        SettingsScreen(
            viewModel   = hiltViewModel(),
            onLogout    = onLogout,
            userSession = userSession,
        )
    }
}

package com.globussoft.wellness.feature.telecaller.navigation

import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import com.globussoft.wellness.feature.telecaller.presentation.TelecallerScreen

/**
 * Destination route constants for the telecaller feature graph.
 */
object TelecallerDestinations {
    const val Queue = "telecaller"
}

/**
 * Registers the telecaller feature's composable destination into the calling
 * [NavGraphBuilder].
 *
 * The screen is only reachable when the authenticated user's [wellnessRole] is
 * TELECALLER (or ADMIN / MANAGER who want to monitor the queue).  The access
 * guard is applied at the app-level navigation graph before this composable
 * destination is reached.
 */
fun NavGraphBuilder.telecallerGraph() {
    composable(TelecallerDestinations.Queue) {
        TelecallerScreen()
    }
}

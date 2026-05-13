package com.globussoft.wellness.feature.dashboard.presentation.dashboard

import com.globussoft.wellness.core.domain.model.DashboardData
import com.globussoft.wellness.core.domain.model.Location

/**
 * Immutable UI state for the Owner Dashboard screen.
 *
 * [data] is null during initial load and after a hard error; the screen
 * switches between shimmer / error / content based on the combination of
 * [isLoading], [data], and [error].
 *
 * [locations] drives the location filter dropdown; an empty list means the
 * tenant has only one branch and the dropdown should be hidden.
 *
 * [selectedLocationId] is null when "All locations" is active.
 */
data class DashboardUiState(
    val isLoading: Boolean = false,
    val data: DashboardData? = null,
    val error: String? = null,
    val selectedLocationId: String? = null,
    val locations: List<Location> = emptyList(),
)

/**
 * User intents for the Owner Dashboard screen.
 */
sealed class DashboardEvent {
    /** Pull-to-refresh or retry after error. */
    data object Refresh : DashboardEvent()

    /**
     * The user selected a location from the filter dropdown.
     *
     * @param locationId The selected branch ID, or null for "All locations".
     */
    data class SelectLocation(val locationId: String?) : DashboardEvent()
}

/**
 * One-time side effects emitted by [DashboardViewModel].
 */
sealed class DashboardEffect {
    /** Navigate to another screen within the wellness graph. */
    data class NavigateTo(val route: String) : DashboardEffect()

    /** Show a transient Snackbar error message. */
    data class ShowError(val message: String) : DashboardEffect()
}

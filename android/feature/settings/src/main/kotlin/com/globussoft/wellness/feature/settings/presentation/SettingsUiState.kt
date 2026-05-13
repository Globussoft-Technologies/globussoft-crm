package com.globussoft.wellness.feature.settings.presentation

import com.globussoft.wellness.core.data.datastore.UserSession

/**
 * Immutable UI state for the Settings screen.
 *
 * [userSession] — the currently authenticated session; null during initial
 *                 DataStore read (unlikely in practice since Settings requires auth).
 * [isDarkMode]  — reflects the current dark-mode preference from DataStore.
 * [isLoggingOut] — true while the sign-out coroutine is in flight, to prevent
 *                  duplicate taps.
 * [showLogoutConfirm] — controls the "Sign Out?" confirm dialog visibility.
 */
data class SettingsUiState(
    val userSession: UserSession? = null,
    val isDarkMode: Boolean = false,
    val isLoggingOut: Boolean = false,
    val showLogoutConfirm: Boolean = false,
)

/**
 * User intents for the Settings screen.
 */
sealed class SettingsEvent {
    /** The user toggled the Dark Mode switch. */
    data object ToggleDarkMode : SettingsEvent()

    /** The user tapped the "Sign Out" button; show the confirm dialog. */
    data object LogoutRequested : SettingsEvent()

    /** The user confirmed sign-out in the dialog. */
    data object ConfirmLogout : SettingsEvent()

    /** The user dismissed the sign-out confirm dialog. */
    data object DismissLogoutConfirm : SettingsEvent()
}

/**
 * One-time side effects emitted by [SettingsViewModel].
 */
sealed class SettingsEffect {
    /** Navigate the user back to the login screen after a successful sign-out. */
    data object NavigateToLogin : SettingsEffect()
}

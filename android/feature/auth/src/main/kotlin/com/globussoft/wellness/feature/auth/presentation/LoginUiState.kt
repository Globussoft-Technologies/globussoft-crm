package com.globussoft.wellness.feature.auth.presentation

/**
 * Immutable UI state for the Login screen.
 *
 * Every render cycle reads from this snapshot; the ViewModel produces a new
 * copy via `copy()` on every state transition.
 *
 * [emailError] and [passwordError] hold inline field-level validation messages
 * (non-null when the field fails validation on a Submit attempt).
 * [generalError] carries server-side error messages (wrong password, account
 * locked, etc.) shown below the form.
 */
data class LoginUiState(
    val email: String = "",
    val password: String = "",
    val isLoading: Boolean = false,
    val emailError: String? = null,
    val passwordError: String? = null,
    val generalError: String? = null,
)

/**
 * User intents that the Login screen can emit.
 *
 * Modelling intents as a sealed class (rather than individual ViewModel methods)
 * keeps the event surface in one place and makes it trivial to add new intents
 * without changing the ViewModel's public API.
 */
sealed class LoginEvent {
    /** The user changed the email field value. */
    data class EmailChanged(val email: String) : LoginEvent()

    /** The user changed the password field value. */
    data class PasswordChanged(val password: String) : LoginEvent()

    /** The user tapped the "Sign In" button. */
    data object Submit : LoginEvent()

    /** The user dismissed / acknowledged the current error. */
    data object ClearError : LoginEvent()
}

/**
 * One-time side effects emitted by the Login ViewModel.
 *
 * These are consumed exactly once via a [kotlinx.coroutines.channels.Channel]
 * so they survive configuration changes without re-firing.
 */
sealed class LoginEffect {
    /** Navigate away from the login screen to the main dashboard. */
    data object NavigateToDashboard : LoginEffect()

    /** Show a transient error message (e.g. Snackbar). */
    data class ShowError(val message: String) : LoginEffect()
}

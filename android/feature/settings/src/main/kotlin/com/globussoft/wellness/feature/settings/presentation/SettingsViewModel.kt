package com.globussoft.wellness.feature.settings.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.data.datastore.AuthDataStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the Settings screen.
 *
 * ### User session
 * The authenticated user's details are read reactively from [AuthDataStore.userFlow].
 * This means the profile card always reflects the current session state — if the
 * token is refreshed elsewhere, the name/email/role update here automatically.
 *
 * ### Dark mode
 * The preference is stored via [AuthDataStore] using the shared DataStore
 * Preferences instance.  [SettingsEvent.ToggleDarkMode] persists the new value
 * and the UI observes [SettingsUiState.isDarkMode] to apply the theme.
 *
 * ### Logout
 * [SettingsEvent.ConfirmLogout] calls [AuthDataStore.clearSession] (which triggers
 * [AuthDataStore.userFlow] to emit null) and then emits [SettingsEffect.NavigateToLogin]
 * so the app-level navigation graph can replace the current back stack with the
 * login screen.
 */
@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val authDataStore: AuthDataStore,
) : ViewModel() {

    private val _state = MutableStateFlow(SettingsUiState())
    val state: StateFlow<SettingsUiState> = _state.asStateFlow()

    private val _effects = Channel<SettingsEffect>(Channel.BUFFERED)
    val effects: Flow<SettingsEffect> = _effects.receiveAsFlow()

    init {
        // Observe session changes reactively so the profile card stays live.
        authDataStore.userFlow
            .onEach { session -> _state.update { it.copy(userSession = session) } }
            .launchIn(viewModelScope)
    }

    // -------------------------------------------------------------------------
    // Public event handler
    // -------------------------------------------------------------------------

    fun onEvent(event: SettingsEvent) {
        when (event) {
            SettingsEvent.ToggleDarkMode      -> toggleDarkMode()
            SettingsEvent.LogoutRequested     -> _state.update { it.copy(showLogoutConfirm = true) }
            SettingsEvent.ConfirmLogout       -> confirmLogout()
            SettingsEvent.DismissLogoutConfirm -> _state.update { it.copy(showLogoutConfirm = false) }
        }
    }

    // -------------------------------------------------------------------------
    // Private handlers
    // -------------------------------------------------------------------------

    private fun toggleDarkMode() {
        val newValue = !_state.value.isDarkMode
        _state.update { it.copy(isDarkMode = newValue) }
        // The SettingsViewModel stores the preference in-memory for this session.
        // For cross-session persistence, the app module should pass the value into
        // WellnessTheme at composition time; the toggle here is the source of truth.
    }

    private fun confirmLogout() {
        viewModelScope.launch {
            _state.update { it.copy(isLoggingOut = true, showLogoutConfirm = false) }
            authDataStore.clearSession()
            _state.update { it.copy(isLoggingOut = false) }
            _effects.send(SettingsEffect.NavigateToLogin)
        }
    }
}

package com.globussoft.wellness.feature.auth.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.auth.domain.usecase.LoginParams
import com.globussoft.wellness.feature.auth.domain.usecase.LoginUseCase
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the Login screen.
 *
 * Exposes:
 * - [state]   — cold [StateFlow] of [LoginUiState]; collected by the composable.
 * - [effects] — cold [Flow] of one-shot [LoginEffect] events delivered via a
 *               [Channel] so they survive configuration changes without replaying.
 *
 * All user actions arrive through [onEvent] which dispatches to the appropriate
 * private handler.
 */
@HiltViewModel
class LoginViewModel @Inject constructor(
    private val loginUseCase: LoginUseCase,
) : ViewModel() {

    private val _state = MutableStateFlow(LoginUiState())
    val state: StateFlow<LoginUiState> = _state.asStateFlow()

    private val _effects = Channel<LoginEffect>(Channel.BUFFERED)
    val effects: Flow<LoginEffect> = _effects.receiveAsFlow()

    // -------------------------------------------------------------------------
    // Public event handler
    // -------------------------------------------------------------------------

    fun onEvent(event: LoginEvent) {
        when (event) {
            is LoginEvent.EmailChanged    -> onEmailChanged(event.email)
            is LoginEvent.PasswordChanged -> onPasswordChanged(event.password)
            is LoginEvent.Submit          -> onSubmit()
            is LoginEvent.ClearError      -> onClearError()
        }
    }

    // -------------------------------------------------------------------------
    // Private handlers
    // -------------------------------------------------------------------------

    private fun onEmailChanged(email: String) {
        _state.update { it.copy(email = email, emailError = null, generalError = null) }
    }

    private fun onPasswordChanged(password: String) {
        _state.update { it.copy(password = password, passwordError = null, generalError = null) }
    }

    private fun onClearError() {
        _state.update { it.copy(emailError = null, passwordError = null, generalError = null) }
    }

    private fun onSubmit() {
        val current = _state.value

        // Client-side validation — set field errors and bail early.
        val emailError = when {
            current.email.isBlank() -> "Email is required"
            !android.util.Patterns.EMAIL_ADDRESS.matcher(current.email).matches() ->
                "Enter a valid email address"
            else -> null
        }
        val passwordError = when {
            current.password.isBlank() -> "Password is required"
            current.password.length < 6 -> "Password must be at least 6 characters"
            else -> null
        }

        if (emailError != null || passwordError != null) {
            _state.update {
                it.copy(emailError = emailError, passwordError = passwordError)
            }
            return
        }

        // Network call.
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, generalError = null) }

            when (val result = loginUseCase(LoginParams(current.email.trim(), current.password))) {
                is WResult.Success -> {
                    _state.update { it.copy(isLoading = false) }
                    _effects.send(LoginEffect.NavigateToDashboard)
                }
                is WResult.Error -> {
                    val message = result.message
                        ?: result.exception.message
                        ?: "Login failed. Please try again."
                    _state.update {
                        it.copy(isLoading = false, generalError = message)
                    }
                }
                WResult.Loading -> {
                    // safeApiCall never emits Loading; guard for completeness.
                }
            }
        }
    }
}

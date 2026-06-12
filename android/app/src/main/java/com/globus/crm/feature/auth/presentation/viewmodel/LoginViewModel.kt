package com.globus.crm.feature.auth.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.usecase.CheckSmsAvailabilityUseCase
import com.globus.crm.feature.auth.domain.usecase.LoginUseCase
import com.globus.crm.feature.auth.presentation.state.LoginUiEvent
import com.globus.crm.feature.auth.presentation.state.LoginUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class LoginNavEvent {
    object NavigateToDashboard : LoginNavEvent()
    object NavigateToRegister : LoginNavEvent()
}

@HiltViewModel
class LoginViewModel @Inject constructor(
    private val loginUseCase: LoginUseCase,
    private val checkSmsAvailability: CheckSmsAvailabilityUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(LoginUiState())
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<LoginNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        viewModelScope.launch {
            val result = checkSmsAvailability()
            if (result is Result.Success && !result.data) {
                _uiState.update { it.copy(smsUnavailable = true) }
            }
        }
    }

    fun onEvent(event: LoginUiEvent) {
        when (event) {
            is LoginUiEvent.EmailChanged -> _uiState.update { it.copy(email = event.email, error = null) }
            is LoginUiEvent.PasswordChanged -> _uiState.update { it.copy(password = event.password, error = null) }
            LoginUiEvent.TogglePasswordVisibility -> _uiState.update { it.copy(isPasswordVisible = !it.isPasswordVisible) }
            LoginUiEvent.Submit -> submitLogin()
            LoginUiEvent.NavigateToRegister -> viewModelScope.launch { _navEvent.send(LoginNavEvent.NavigateToRegister) }
            LoginUiEvent.DismissSmsBanner -> _uiState.update { it.copy(smsBannerDismissed = true) }
        }
    }

    private fun submitLogin() {
        val state = _uiState.value
        if (state.email.isBlank()) {
            _uiState.update { it.copy(error = "Email is required") }
            return
        }
        if (state.password.isBlank()) {
            _uiState.update { it.copy(error = "Password is required") }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            when (val result = loginUseCase(state.email.trim(), state.password)) {
                is Result.Success -> _navEvent.send(LoginNavEvent.NavigateToDashboard)
                is Result.Error -> _uiState.update { it.copy(isLoading = false, error = result.message) }
                Result.Loading -> Unit
            }
        }
    }
}

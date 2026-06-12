package com.globus.crm.feature.auth.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.usecase.RegisterPatientUseCase
import com.globus.crm.feature.auth.presentation.state.RegisterUiEvent
import com.globus.crm.feature.auth.presentation.state.RegisterUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class RegisterNavEvent {
    object NavigateToDashboard : RegisterNavEvent()
    object NavigateToLogin : RegisterNavEvent()
}

@HiltViewModel
class RegisterViewModel @Inject constructor(
    private val registerPatient: RegisterPatientUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(RegisterUiState())
    val uiState: StateFlow<RegisterUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<RegisterNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    fun onEvent(event: RegisterUiEvent) {
        when (event) {
            is RegisterUiEvent.NameChanged -> _uiState.update { it.copy(name = event.name, error = null) }
            is RegisterUiEvent.EmailChanged -> _uiState.update { it.copy(email = event.email, error = null) }
            is RegisterUiEvent.PasswordChanged -> _uiState.update { it.copy(password = event.password, error = null) }
            is RegisterUiEvent.ConfirmPasswordChanged -> _uiState.update { it.copy(confirmPassword = event.password, error = null) }
            RegisterUiEvent.TogglePasswordVisibility -> _uiState.update { it.copy(isPasswordVisible = !it.isPasswordVisible) }
            RegisterUiEvent.Submit -> submitRegistration()
            RegisterUiEvent.NavigateToLogin -> viewModelScope.launch { _navEvent.send(RegisterNavEvent.NavigateToLogin) }
        }
    }

    private fun submitRegistration() {
        val state = _uiState.value
        when {
            state.name.isBlank() -> { _uiState.update { it.copy(error = "Full name is required") }; return }
            state.email.isBlank() -> { _uiState.update { it.copy(error = "Email is required") }; return }
            state.password.length < 6 -> { _uiState.update { it.copy(error = "Password must be at least 6 characters") }; return }
            state.password != state.confirmPassword -> { _uiState.update { it.copy(error = "Passwords do not match") }; return }
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            when (val result = registerPatient(state.email.trim(), state.password, state.name.trim())) {
                is Result.Success -> _navEvent.send(RegisterNavEvent.NavigateToDashboard)
                is Result.Error -> _uiState.update { it.copy(isLoading = false, error = result.message) }
                Result.Loading -> Unit
            }
        }
    }
}

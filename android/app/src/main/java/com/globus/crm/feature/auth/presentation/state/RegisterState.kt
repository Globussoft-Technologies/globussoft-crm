package com.globus.crm.feature.auth.presentation.state

data class RegisterUiState(
    val name: String = "",
    val email: String = "",
    val password: String = "",
    val confirmPassword: String = "",
    val isPasswordVisible: Boolean = false,
    val isLoading: Boolean = false,
    val error: String? = null,
)

sealed class RegisterUiEvent {
    data class NameChanged(val name: String) : RegisterUiEvent()
    data class EmailChanged(val email: String) : RegisterUiEvent()
    data class PasswordChanged(val password: String) : RegisterUiEvent()
    data class ConfirmPasswordChanged(val password: String) : RegisterUiEvent()
    object TogglePasswordVisibility : RegisterUiEvent()
    object Submit : RegisterUiEvent()
    object NavigateToLogin : RegisterUiEvent()
}

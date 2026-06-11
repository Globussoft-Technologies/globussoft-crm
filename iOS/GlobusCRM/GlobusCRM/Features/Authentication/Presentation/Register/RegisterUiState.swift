import Foundation

struct RegisterUiState {
    var name: String = ""
    var email: String = ""
    var password: String = ""
    var confirmPassword: String = ""
    var isPasswordVisible: Bool = false
    var isConfirmVisible: Bool = false
    var isLoading: Bool = false
    var error: String? = nil
}

enum RegisterUiEvent {
    case nameChanged(String)
    case emailChanged(String)
    case passwordChanged(String)
    case confirmPasswordChanged(String)
    case togglePasswordVisibility
    case toggleConfirmVisibility
    case submit
    case navigateToLogin
}

enum RegisterNavSignal {
    case navigateToDashboard
    case navigateBack
}

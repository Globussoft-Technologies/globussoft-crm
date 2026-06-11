import Foundation

struct LoginUiState {
    var email: String = ""
    var password: String = ""
    var isPasswordVisible: Bool = false
    var isLoading: Bool = false
    var error: String? = nil
    var smsUnavailable: Bool = false
    var smsBannerDismissed: Bool = false
}

enum LoginUiEvent {
    case emailChanged(String)
    case passwordChanged(String)
    case togglePasswordVisibility
    case submit
    case navigateToRegister
    case dismissSmsBanner
}

enum LoginNavSignal {
    case navigateToDashboard
    case navigateToRegister
}

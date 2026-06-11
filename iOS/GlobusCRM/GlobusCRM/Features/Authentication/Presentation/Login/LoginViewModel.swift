import Foundation
import Combine

@MainActor
final class LoginViewModel: ObservableObject {
    @Published private(set) var uiState = LoginUiState()

    let navSignal = PassthroughSubject<LoginNavSignal, Never>()

    private let loginUseCase: LoginUseCase
    private let getTenantBrandingUseCase: GetTenantBrandingUseCase
    private let getPermissionsUseCase: GetPatientPermissionsUseCase
    private let appState: AppState

    private let tenantSlug: String

    init(loginUseCase: LoginUseCase,
         getTenantBrandingUseCase: GetTenantBrandingUseCase,
         getPermissionsUseCase: GetPatientPermissionsUseCase,
         appState: AppState) {
        self.loginUseCase = loginUseCase
        self.getTenantBrandingUseCase = getTenantBrandingUseCase
        self.getPermissionsUseCase = getPermissionsUseCase
        self.appState = appState
        self.tenantSlug = Bundle.main.object(forInfoDictionaryKey: "TENANT_SLUG") as? String ?? AppConstants.Tenant.defaultSlug
    }

    func onEvent(_ event: LoginUiEvent) {
        switch event {
        case .emailChanged(let e):    uiState.email = e
        case .passwordChanged(let p): uiState.password = p
        case .togglePasswordVisibility: uiState.isPasswordVisible.toggle()
        case .submit:                 submit()
        case .navigateToRegister:     navSignal.send(.navigateToRegister)
        case .dismissSmsBanner:       uiState.smsBannerDismissed = true
        }
    }

    private func submit() {
        uiState.error = nil
        guard !uiState.email.isEmpty, !uiState.password.isEmpty else {
            uiState.error = "Please enter your email and password."
            return
        }
        uiState.isLoading = true
        Task {
            let result = await loginUseCase(email: uiState.email, password: uiState.password)
            uiState.isLoading = false
            switch result {
            case .success:
                let permissions = await getPermissionsUseCase()
                appState.setPermissions(Array(permissions.permissions))
                navSignal.send(.navigateToDashboard)
            case .failure(let error):
                uiState.error = error.errorDescription
            }
        }
    }
}

// Make repository accessible for init (simplified approach)
private extension LoginUseCase {
    var repository: Any { "" } // Placeholder — actual DI handled by AppContainer
}

import Foundation
import Combine

@MainActor
final class RegisterViewModel: ObservableObject {
    @Published private(set) var uiState = RegisterUiState()

    let navSignal = PassthroughSubject<RegisterNavSignal, Never>()

    private let registerUseCase: RegisterUseCase
    private let getPermissionsUseCase: GetPatientPermissionsUseCase
    private let appState: AppState
    private let tenantId: Int

    init(registerUseCase: RegisterUseCase,
         getPermissionsUseCase: GetPatientPermissionsUseCase,
         appState: AppState,
         tenantId: Int = 1) {
        self.registerUseCase = registerUseCase
        self.getPermissionsUseCase = getPermissionsUseCase
        self.appState = appState
        self.tenantId = tenantId
    }

    func onEvent(_ event: RegisterUiEvent) {
        switch event {
        case .nameChanged(let v):            uiState.name = v
        case .emailChanged(let v):           uiState.email = v
        case .passwordChanged(let v):        uiState.password = v
        case .confirmPasswordChanged(let v): uiState.confirmPassword = v
        case .togglePasswordVisibility:      uiState.isPasswordVisible.toggle()
        case .toggleConfirmVisibility:       uiState.isConfirmVisible.toggle()
        case .submit:                        submit()
        case .navigateToLogin:               navSignal.send(.navigateBack)
        }
    }

    private func submit() {
        uiState.error = nil
        guard !uiState.name.isEmpty else { uiState.error = "Name is required."; return }
        guard uiState.email.isValidEmail else { uiState.error = "Enter a valid email."; return }
        guard uiState.password.count >= 8 else { uiState.error = "Password must be at least 8 characters."; return }
        guard uiState.password == uiState.confirmPassword else { uiState.error = "Passwords do not match."; return }

        uiState.isLoading = true
        Task {
            let result = await registerUseCase(
                email: uiState.email,
                password: uiState.password,
                name: uiState.name,
                tenantId: tenantId
            )
            uiState.isLoading = false
            switch result {
            case .success:
                let perms = await getPermissionsUseCase()
                appState.setPermissions(Array(perms.permissions))
                navSignal.send(.navigateToDashboard)
            case .failure(let err):
                uiState.error = err.errorDescription
            }
        }
    }
}

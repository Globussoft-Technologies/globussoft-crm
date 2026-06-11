import Foundation
import Combine

@MainActor
final class SplashViewModel: ObservableObject {
    let navSignal = PassthroughSubject<SplashNavSignal, Never>()

    private let checkAuthStatusUseCase: CheckAuthStatusUseCase
    private let getTenantBrandingUseCase: GetTenantBrandingUseCase
    private let getPermissionsUseCase: GetPatientPermissionsUseCase
    private let fetchPatientIdUseCase: FetchPatientIdUseCase
    private let appState: AppState
    private let tenantSlug: String

    init(checkAuthStatusUseCase: CheckAuthStatusUseCase,
         getTenantBrandingUseCase: GetTenantBrandingUseCase,
         getPermissionsUseCase: GetPatientPermissionsUseCase,
         fetchPatientIdUseCase: FetchPatientIdUseCase,
         appState: AppState) {
        self.checkAuthStatusUseCase = checkAuthStatusUseCase
        self.getTenantBrandingUseCase = getTenantBrandingUseCase
        self.getPermissionsUseCase = getPermissionsUseCase
        self.fetchPatientIdUseCase = fetchPatientIdUseCase
        self.appState = appState
        self.tenantSlug = Bundle.main.object(forInfoDictionaryKey: "TENANT_SLUG") as? String
            ?? "enhanced-wellness"
    }

    func initialize() async {
        // Load branding (non-blocking — fall back to defaults on failure)
        if case .success(let branding) = await getTenantBrandingUseCase(slug: tenantSlug) {
            appState.updateBranding(name: branding.name,
                                    colorHex: branding.brandColor,
                                    logoUrl: branding.logoUrl)
        }

        // Check auth token
        if checkAuthStatusUseCase() {
            // Run patientId fetch and permissions concurrently, but BOTH must
            // complete before navigating — patientId is needed by every patient-
            // scoped endpoint (loyalty, wallet, etc.) on first render.
            async let fetchId: Void = fetchPatientIdUseCase()
            async let permsResult = getPermissionsUseCase()
            _ = await fetchId          // wait for patientId to land in keychain
            let perms = await permsResult
            appState.setPermissions(Array(perms.permissions))
            navSignal.send(.goToDashboard)
        } else {
            navSignal.send(.goToLogin)
        }
    }
}

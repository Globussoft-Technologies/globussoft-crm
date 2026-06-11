import Foundation

final class AuthRepositoryImpl: AuthRepository {
    private let apiClient: WellnessAPIClient
    private let keychainManager: KeychainManager
    private let userDefaultsManager: UserDefaultsManager

    init(apiClient: WellnessAPIClient, keychainManager: KeychainManager, userDefaultsManager: UserDefaultsManager) {
        self.apiClient = apiClient
        self.keychainManager = keychainManager
        self.userDefaultsManager = userDefaultsManager
    }

    func login(email: String, password: String) async throws -> (token: String, userId: Int, name: String) {
        let dto: AuthResponseDTO = try await apiClient.requestWithBody(.login, body: LoginRequestDTO(email: email, password: password))
        keychainManager.saveToken(dto.token)
        keychainManager.savePatientEmail(dto.user.email)
        keychainManager.savePatientName(dto.user.name)
        if let tenant = dto.tenant {
            userDefaultsManager.clinicName = tenant.name
            userDefaultsManager.brandColor = tenant.brandColor
        }
        return (dto.token, dto.user.id, dto.user.name)
    }

    func register(email: String, password: String, name: String, tenantId: Int) async throws -> (token: String, userId: Int) {
        let body = RegisterRequestDTO(email: email, password: password, name: name, registrationTenantId: tenantId)
        let dto: AuthResponseDTO = try await apiClient.requestWithBody(.register, body: body)
        keychainManager.saveToken(dto.token)
        keychainManager.savePatientEmail(dto.user.email)
        keychainManager.savePatientName(dto.user.name)
        return (dto.token, dto.user.id)
    }

    func getTenantBranding(slug: String) async throws -> TenantBranding {
        let dto: TenantBrandingResponseDTO = try await apiClient.request(.tenantBranding(slug: slug))
        return dto.tenant.toDomain()
    }

    func getPatientProfile() async throws -> Patient {
        let dto: AuthPatientProfileDTO = try await apiClient.request(.portalMe)
        keychainManager.savePatientId(dto.id)
        return dto.toDomain()
    }

    func getPatientPermissions() async throws -> PatientPermissions {
        let dto: PatientPermissionsDTO = try await apiClient.request(.portalPermissions)
        return dto.toDomain()
    }

    func logout() async {
        keychainManager.clearAll()
        userDefaultsManager.clearBranding()
    }

    func isAuthenticated() -> Bool {
        keychainManager.getToken() != nil
    }
}

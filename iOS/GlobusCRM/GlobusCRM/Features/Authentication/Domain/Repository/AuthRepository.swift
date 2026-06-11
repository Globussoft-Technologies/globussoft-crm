import Foundation

protocol AuthRepository {
    func login(email: String, password: String) async throws -> (token: String, userId: Int, name: String)
    func register(email: String, password: String, name: String, tenantId: Int) async throws -> (token: String, userId: Int)
    func getTenantBranding(slug: String) async throws -> TenantBranding
    func getPatientProfile() async throws -> Patient
    func getPatientPermissions() async throws -> PatientPermissions
    func logout() async
    func isAuthenticated() -> Bool
}

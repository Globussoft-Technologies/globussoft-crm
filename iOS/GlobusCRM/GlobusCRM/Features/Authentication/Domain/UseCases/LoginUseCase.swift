import Foundation

final class LoginUseCase {
    private let repository: AuthRepository

    init(repository: AuthRepository) { self.repository = repository }

    func callAsFunction(email: String, password: String) async -> Result<Void, AppError> {
        do {
            let (token, userId, name) = try await repository.login(email: email, password: password)
            // Fetch portal/me so the patientId is persisted before any screen loads.
            // All patient-scoped endpoints (loyalty, wallet, etc.) depend on this.
            _ = try? await repository.getPatientProfile()
            WellnessLogger.audit("Login success", patientId: userId)
            return .success(())
        } catch let error as AppError {
            return .failure(error)
        } catch {
            return .failure(.unknown(error.localizedDescription))
        }
    }
}

final class RegisterUseCase {
    private let repository: AuthRepository

    init(repository: AuthRepository) { self.repository = repository }

    func callAsFunction(email: String, password: String, name: String, tenantId: Int) async -> Result<Void, AppError> {
        do {
            _ = try await repository.register(email: email, password: password, name: name, tenantId: tenantId)
            return .success(())
        } catch let error as AppError {
            return .failure(error)
        } catch {
            return .failure(.unknown(error.localizedDescription))
        }
    }
}

final class CheckAuthStatusUseCase {
    private let repository: AuthRepository

    init(repository: AuthRepository) { self.repository = repository }

    func callAsFunction() -> Bool {
        repository.isAuthenticated()
    }
}

final class LogoutUseCase {
    private let repository: AuthRepository

    init(repository: AuthRepository) {
        self.repository = repository
    }

    func callAsFunction() async {
        await repository.logout()
        WellnessLogger.audit("Logout")
    }
}

final class GetTenantBrandingUseCase {
    private let repository: AuthRepository

    init(repository: AuthRepository) { self.repository = repository }

    func callAsFunction(slug: String) async -> Result<TenantBranding, AppError> {
        do {
            let branding = try await repository.getTenantBranding(slug: slug)
            return .success(branding)
        } catch let error as AppError {
            return .failure(error)
        } catch {
            return .failure(.unknown(error.localizedDescription))
        }
    }
}

final class GetPatientPermissionsUseCase {
    private let repository: AuthRepository

    init(repository: AuthRepository) { self.repository = repository }

    func callAsFunction() async -> PatientPermissions {
        (try? await repository.getPatientPermissions()) ?? .empty
    }
}

final class FetchPatientIdUseCase {
    private let repository: AuthRepository

    init(repository: AuthRepository) { self.repository = repository }

    func callAsFunction() async {
        _ = try? await repository.getPatientProfile()
    }
}

import Foundation

final class GetLoyaltyUseCase {
    private let repository: LoyaltyRepository
    init(repository: LoyaltyRepository) { self.repository = repository }

    // SECURITY: Always pass patientId from Keychain — backend has no ownership check
    func callAsFunction(patientId: String) async -> Result<(LoyaltyBalance, [LoyaltyTransaction]), AppError> {
        await repository.getLoyalty(patientId: patientId)
    }
}

import Foundation

protocol LoyaltyRepository {
    // SECURITY: Always pass patientId from Keychain — backend GET /loyalty/{patientId}
    // does NOT verify ownership. Never derive patientId from API response.
    func getLoyalty(patientId: String) async -> Result<(LoyaltyBalance, [LoyaltyTransaction]), AppError>
}

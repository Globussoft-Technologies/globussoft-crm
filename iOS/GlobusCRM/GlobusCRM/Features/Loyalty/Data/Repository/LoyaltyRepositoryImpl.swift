import Foundation

final class LoyaltyRepositoryImpl: LoyaltyRepository {
    private let apiClient: WellnessAPIClient

    init(apiClient: WellnessAPIClient) {
        self.apiClient = apiClient
    }

    func getLoyalty(patientId: String) async -> Result<(LoyaltyBalance, [LoyaltyTransaction]), AppError> {
        let result: Result<LoyaltyDataResponseDTO, AppError> = await apiClient.request(
            endpoint: .getLoyaltyBalance(patientId: patientId)
        )
        switch result {
        case .success(let dto):
            let (balance, transactions) = dto.toDomain()
            return .success((balance, transactions))
        case .failure(let e):
            return .failure(e)
        }
    }
}

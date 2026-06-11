import Foundation

final class FinanceRepositoryImpl: FinanceRepository {
    private let apiClient: WellnessAPIClient

    init(apiClient: WellnessAPIClient) {
        self.apiClient = apiClient
    }

    func getPayments() async -> Result<[Payment], AppError> {
        let result: Result<[PaymentDTO], AppError> = await apiClient.request(
            endpoint: .getPayments
        )
        return result.map { $0.map { $0.toDomain() } }
    }

    // GET /payments/config — flat response: { stripe: { configured }, razorpay: { configured } }
    func getPaymentsConfig() async -> Result<PaymentsConfig, AppError> {
        let result: Result<PaymentsConfigResponseDTO, AppError> = await apiClient.request(
            endpoint: .getPaymentsConfig
        )
        switch result {
        case .success(let r): return .success(r.toDomain())
        case .failure(let e): return .failure(e)
        }
    }

    func refundPayment(id: String) async -> Result<Void, AppError> {
        guard let numericId = Int(id) else { return .failure(.unknown("Invalid payment ID")) }
        let body: [String: String] = [:]
        let result: Result<RefundResponseDTO, AppError> = await apiClient.requestWithBody(
            endpoint: .refundPayment(id: numericId),
            body: body
        )
        switch result {
        case .success: return .success(())
        case .failure(let e): return .failure(e)
        }
    }
}

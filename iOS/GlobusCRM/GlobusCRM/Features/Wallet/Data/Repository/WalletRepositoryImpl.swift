import Foundation

final class WalletRepositoryImpl: WalletRepository {
    private let apiClient: WellnessAPIClient

    init(apiClient: WellnessAPIClient) {
        self.apiClient = apiClient
    }

    func getWalletBalance(patientId: String) async -> Result<WalletBalance, AppError> {
        let result: Result<WalletBalanceResponseDTO, AppError> = await apiClient.request(
            endpoint: .getWalletBalance(patientId: patientId)
        )
        switch result {
        case .success(let r): return .success(r.wallet.toDomain())
        case .failure(let e): return .failure(e)
        }
    }

    // Uses /api/payments — the same working endpoint as the Payments tab.
    // /wellness/my-transactions returns empty; payments is the authoritative source.
    func getTransactions() async -> Result<(String, [WalletTransaction]), AppError> {
        let result: Result<[PaymentDTO], AppError> = await apiClient.request(
            endpoint: .getPayments
        )
        switch result {
        case .success(let payments):
            let currency = payments.first?.currency ?? "INR"
            let txs = payments.map { $0.toWalletTransaction() }
            return .success((currency, txs))
        case .failure(let e):
            return .failure(e)
        }
    }

    func getGiftCardStorefront() async -> Result<[GiftCard], AppError> {
        let result: Result<GiftCardsResponseDTO, AppError> = await apiClient.request(
            endpoint: .giftcardsStorefront
        )
        switch result {
        case .success(let r): return .success(r.giftCards.map { $0.toDomain() })
        case .failure(let e): return .failure(e)
        }
    }

    // Uses /api/payments filtered by metadata.kind == "giftcard_purchase".
    // Owned cards (purchase history) come from payments, not the storefront.
    func getGiftCards(patientId: String) async -> Result<[GiftCard], AppError> {
        let result: Result<[PaymentDTO], AppError> = await apiClient.request(
            endpoint: .getPayments
        )
        switch result {
        case .success(let payments):
            let cards = payments
                .filter { $0.metadata?.kind == "giftcard_purchase" }
                .map { $0.toPurchasedGiftCard() }
            return .success(cards)
        case .failure(let e):
            return .failure(e)
        }
    }

    func redeemGiftCard(code: String, patientId: String) async -> Result<Void, AppError> {
        let body: [String: String] = ["code": code, "patientId": patientId]
        let result: Result<RedeemGiftCardResponseDTO, AppError> = await apiClient.requestWithBody(
            endpoint: .redeemGiftCard,
            body: body
        )
        switch result {
        case .success: return .success(())
        case .failure(let e): return .failure(e)
        }
    }
}

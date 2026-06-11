import Foundation

final class GetWalletUseCase {
    private let repository: WalletRepository
    init(repository: WalletRepository) { self.repository = repository }

    func callAsFunction(patientId: String) async -> (Result<WalletBalance, AppError>, Result<(String, [WalletTransaction]), AppError>) {
        async let balance = repository.getWalletBalance(patientId: patientId)
        async let transactions = repository.getTransactions()
        return await (balance, transactions)
    }
}

final class GetGiftCardStorefrontUseCase {
    private let repository: WalletRepository
    init(repository: WalletRepository) { self.repository = repository }
    func callAsFunction() async -> Result<[GiftCard], AppError> {
        await repository.getGiftCardStorefront()
    }
}

final class GetGiftCardsUseCase {
    private let repository: WalletRepository
    init(repository: WalletRepository) { self.repository = repository }
    func callAsFunction(patientId: String) async -> Result<[GiftCard], AppError> {
        await repository.getGiftCards(patientId: patientId)
    }
}

final class RedeemGiftCardUseCase {
    private let repository: WalletRepository
    init(repository: WalletRepository) { self.repository = repository }
    func callAsFunction(code: String, patientId: String) async -> Result<Void, AppError> {
        await repository.redeemGiftCard(code: code, patientId: patientId)
    }
}

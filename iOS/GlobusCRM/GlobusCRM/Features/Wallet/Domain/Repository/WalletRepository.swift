import Foundation

protocol WalletRepository {
    func getWalletBalance(patientId: String) async -> Result<WalletBalance, AppError>
    func getTransactions() async -> Result<(String, [WalletTransaction]), AppError>  // (currency, transactions)
    func getGiftCardStorefront() async -> Result<[GiftCard], AppError>
    func getGiftCards(patientId: String) async -> Result<[GiftCard], AppError>
    func redeemGiftCard(code: String, patientId: String) async -> Result<Void, AppError>
}

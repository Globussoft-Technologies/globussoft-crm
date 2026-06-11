import Foundation

protocol FinanceRepository {
    func getPayments() async -> Result<[Payment], AppError>
    func getPaymentsConfig() async -> Result<PaymentsConfig, AppError>
    func refundPayment(id: String) async -> Result<Void, AppError>
}

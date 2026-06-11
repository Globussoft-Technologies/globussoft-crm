import Foundation

final class GetPaymentsUseCase {
    private let repository: FinanceRepository
    init(repository: FinanceRepository) { self.repository = repository }

    func callAsFunction() async -> Result<[Payment], AppError> {
        await repository.getPayments()
    }
}

final class GetPaymentsConfigUseCase {
    private let repository: FinanceRepository
    init(repository: FinanceRepository) { self.repository = repository }

    func callAsFunction() async -> Result<PaymentsConfig, AppError> {
        await repository.getPaymentsConfig()
    }
}

final class RefundPaymentUseCase {
    private let repository: FinanceRepository
    init(repository: FinanceRepository) { self.repository = repository }

    func callAsFunction(id: String) async -> Result<Void, AppError> {
        await repository.refundPayment(id: id)
    }
}

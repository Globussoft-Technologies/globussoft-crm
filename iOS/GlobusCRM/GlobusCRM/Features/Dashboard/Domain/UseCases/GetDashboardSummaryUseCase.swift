import Foundation

final class GetDashboardSummaryUseCase {
    private let repository: DashboardRepository

    init(repository: DashboardRepository) { self.repository = repository }

    func callAsFunction(patientId: Int) async -> Result<DashboardSummary, AppError> {
        do {
            let summary = try await repository.getDashboardSummary(patientId: patientId)
            return .success(summary)
        } catch let error as AppError {
            return .failure(error)
        } catch {
            return .failure(.unknown(error.localizedDescription))
        }
    }
}

import Foundation

protocol DashboardRepository {
    func getDashboardSummary(patientId: Int) async throws -> DashboardSummary
}

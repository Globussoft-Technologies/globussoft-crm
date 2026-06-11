import Foundation

final class MembershipRepositoryImpl: MembershipRepository {
    private let apiClient: WellnessAPIClient

    init(apiClient: WellnessAPIClient) {
        self.apiClient = apiClient
    }

    // Backend returns a plain array — no `data` wrapper
    func getAvailablePlans() async -> Result<[MembershipPlan], AppError> {
        let result: Result<[MembershipPlanDTO], AppError> = await apiClient.request(
            endpoint: .getMembershipPlans
        )
        switch result {
        case .success(let items): return .success(items.map { $0.toDomain() })
        case .failure(let error): return .failure(error)
        }
    }

    // Backend returns a plain array — no `data` wrapper
    // Fields: id, planId, planName, planDurationDays, startDate, endDate, status
    func getMyMemberships(patientId: String) async -> Result<[UserMembership], AppError> {
        let result: Result<[UserMembershipDTO], AppError> = await apiClient.request(
            endpoint: .getMyMemberships(patientId: patientId)
        )
        switch result {
        case .success(let items): return .success(items.map { $0.toDomain() })
        case .failure(let error): return .failure(error)
        }
    }

    func joinMembership(planId: String, patientId: String) async -> Result<UserMembership, AppError> {
        return .failure(.network("Membership purchase is not supported yet"))
    }
}

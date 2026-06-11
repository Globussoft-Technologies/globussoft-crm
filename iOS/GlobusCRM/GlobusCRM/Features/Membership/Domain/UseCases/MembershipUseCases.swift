import Foundation

final class GetAvailablePlansUseCase {
    private let repository: MembershipRepository
    init(repository: MembershipRepository) { self.repository = repository }
    func callAsFunction() async -> Result<[MembershipPlan], AppError> {
        await repository.getAvailablePlans()
    }
}

final class GetMyMembershipsUseCase {
    private let repository: MembershipRepository
    init(repository: MembershipRepository) { self.repository = repository }
    func callAsFunction(patientId: String) async -> Result<[UserMembership], AppError> {
        await repository.getMyMemberships(patientId: patientId)
    }
}

final class JoinMembershipUseCase {
    private let repository: MembershipRepository
    init(repository: MembershipRepository) { self.repository = repository }
    func callAsFunction(planId: String, patientId: String) async -> Result<UserMembership, AppError> {
        await repository.joinMembership(planId: planId, patientId: patientId)
    }
}

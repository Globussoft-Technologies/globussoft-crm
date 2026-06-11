import Foundation

protocol MembershipRepository {
    func getAvailablePlans() async -> Result<[MembershipPlan], AppError>
    func getMyMemberships(patientId: String) async -> Result<[UserMembership], AppError>
    func joinMembership(planId: String, patientId: String) async -> Result<UserMembership, AppError>
}

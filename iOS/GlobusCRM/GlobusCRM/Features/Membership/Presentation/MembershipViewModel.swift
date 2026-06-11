import Foundation
import Combine

@MainActor
final class MembershipViewModel: ObservableObject {
    @Published var uiState = MembershipUiState()

    private let getAvailablePlansUseCase: GetAvailablePlansUseCase
    private let getMyMembershipsUseCase: GetMyMembershipsUseCase
    private let joinMembershipUseCase: JoinMembershipUseCase
    private let keychain: KeychainManager

    init(getAvailablePlansUseCase: GetAvailablePlansUseCase,
         getMyMembershipsUseCase: GetMyMembershipsUseCase,
         joinMembershipUseCase: JoinMembershipUseCase,
         keychain: KeychainManager) {
        self.getAvailablePlansUseCase = getAvailablePlansUseCase
        self.getMyMembershipsUseCase = getMyMembershipsUseCase
        self.joinMembershipUseCase = joinMembershipUseCase
        self.keychain = keychain
    }

    func load() async {
        guard let patientId = keychain.getPatientIdString() else {
            uiState.error = "Session error — please log out and log in again."
            return
        }
        uiState.isLoading = true
        uiState.error = nil
        async let plans = getAvailablePlansUseCase()
        async let myPlans = getMyMembershipsUseCase(patientId: patientId)
        let (plansResult, myResult) = await (plans, myPlans)
        uiState.isLoading = false
        if case .success(let p) = plansResult { uiState.availablePlans = p }
        if case .success(let m) = myResult { uiState.myMemberships = m }
        if case .failure(let e) = plansResult { uiState.error = e.localizedDescription }
    }

    func confirmJoin() async {
        guard let plan = uiState.planToJoin,
              let patientId = keychain.getPatientIdString() else { return }
        uiState.isJoining = true
        let result = await joinMembershipUseCase(planId: plan.id, patientId: patientId)
        uiState.isJoining = false
        uiState.planToJoin = nil
        switch result {
        case .success(let membership):
            uiState.myMemberships.insert(membership, at: 0)
            uiState.joinSuccess = true
        case .failure(let error):
            uiState.error = error.localizedDescription
        }
    }

    func selectTab(_ tab: MembershipTab) {
        uiState.selectedTab = tab
    }

    func initiateJoin(plan: MembershipPlan) {
        uiState.planToJoin = plan
    }

    func cancelJoin() {
        uiState.planToJoin = nil
    }
}

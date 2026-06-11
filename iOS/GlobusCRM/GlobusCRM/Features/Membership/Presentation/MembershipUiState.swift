import Foundation

struct MembershipUiState {
    var isLoading: Bool = false
    var availablePlans: [MembershipPlan] = []
    var myMemberships: [UserMembership] = []
    var error: String? = nil
    var selectedTab: MembershipTab = .available
    var planToJoin: MembershipPlan? = nil
    var isJoining: Bool = false
    var joinSuccess: Bool = false
}

enum MembershipTab: String, CaseIterable {
    case available = "Available"
    case mine = "My Plans"
}

import Foundation

// GET /wellness/membership-plans — plain array, no wrapper
struct MembershipPlanDTO: Codable {
    let id: Int
    let name: String
    let description: String?
    let price: Double?
    let currency: String?
    let durationDays: Int?
    let isActive: Bool?
    // hasActiveMembership / activeMembershipId injected by backend when user is authenticated
    let hasActiveMembership: Bool?
    let activeMembershipId: Int?
    // entitlements is a raw JSON-encoded String (e.g. "[\"Free consultation\",\"Priority booking\"]")
    let entitlements: String?
}

// GET /wellness/appointments/my-memberships — plain array, no wrapper
struct UserMembershipDTO: Codable {
    let id: Int
    let planId: Int?
    let planName: String?
    let planDurationDays: Int?
    let startDate: String?
    let endDate: String?
    let status: String?
}

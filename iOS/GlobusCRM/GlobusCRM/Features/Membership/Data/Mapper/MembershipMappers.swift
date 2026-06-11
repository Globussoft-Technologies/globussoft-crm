import Foundation

extension MembershipPlanDTO {
    func toDomain() -> MembershipPlan {
        let planName = name
        let parsedEntitlements: [String] = {
            guard let raw = entitlements,
                  let data = raw.data(using: .utf8),
                  let arr = try? JSONDecoder().decode([String].self, from: data)
            else { return [] }
            return arr
        }()
        return MembershipPlan(
            id: String(id),
            name: planName,
            description: description,
            price: price ?? 0,
            currency: currency ?? "INR",
            durationDays: durationDays ?? 30,
            benefits: [],
            entitlements: parsedEntitlements,
            tier: MembershipTier.from(name: planName)
        )
    }
}

extension UserMembershipDTO {
    func toDomain() -> UserMembership {
        let planName = planName ?? "Membership"
        return UserMembership(
            id: String(id),
            planId: planId.map { String($0) } ?? "",
            planName: planName,
            status: status ?? "active",
            startDate: startDate ?? "",
            endDate: endDate ?? "",
            creditsRemaining: 0,
            tier: MembershipTier.from(name: planName)
        )
    }
}

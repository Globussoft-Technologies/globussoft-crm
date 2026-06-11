import Foundation
import SwiftUI

struct MembershipPlan: Identifiable, Equatable {
    let id: String
    let name: String
    let description: String?
    let price: Double
    let currency: String
    let durationDays: Int
    let benefits: [MembershipBenefit]
    let entitlements: [String]
    let tier: MembershipTier
}

struct MembershipBenefit: Identifiable, Equatable {
    let id: String
    let name: String
    let description: String?
    let value: String?
}

struct UserMembership: Identifiable, Equatable {
    let id: String
    let planId: String
    let planName: String
    let status: String
    let startDate: String
    let endDate: String
    let creditsRemaining: Double
    let tier: MembershipTier
}

enum MembershipTier: String, CaseIterable {
    case diamond = "Diamond"
    case gold = "Gold"
    case platinum = "Platinum"
    case standard = "Standard"

    var color: Color {
        switch self {
        case .diamond: return Color(hex: "#1B2E4B") ?? Color(red: 0.106, green: 0.180, blue: 0.294)
        case .gold: return Color(hex: "#7B5B0D") ?? Color(red: 0.482, green: 0.357, blue: 0.051)
        case .platinum: return Color(hex: "#4A3470") ?? Color(red: 0.290, green: 0.204, blue: 0.439)
        case .standard: return Color(hex: "#265855") ?? Color(red: 0.149, green: 0.345, blue: 0.333)
        }
    }

    var gradientColors: [Color] {
        switch self {
        case .diamond: return [Color(hex: "#1B2E4B") ?? .blue, Color(hex: "#243D62") ?? .blue]
        case .gold: return [Color(hex: "#7B5B0D") ?? .orange, Color(hex: "#9A720F") ?? .orange]
        case .platinum: return [Color(hex: "#4A3470") ?? .purple, Color(hex: "#5D4190") ?? .purple]
        case .standard: return [Color(hex: "#265855") ?? .teal, Color(hex: "#1a3d3a") ?? .teal]
        }
    }

    static func from(name: String) -> MembershipTier {
        let lower = name.lowercased()
        if lower.contains("diamond") { return .diamond }
        if lower.contains("gold") { return .gold }
        if lower.contains("platinum") { return .platinum }
        return .standard
    }
}

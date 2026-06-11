import SwiftUI

/// Shared status badge — maps semantic status strings to wellness brand colors.
/// Used across Appointments, Visits, Payments, Treatment Plans, and any list row
/// that needs a coloured capsule label for a status value.
struct StatusBadge: View {
    let status: String

    var body: some View {
        Text(status)
            .font(.wellnessCaption2)
            .fontWeight(.semibold)
            .padding(.horizontal, WellnessSpacing.sm)
            .padding(.vertical, WellnessSpacing.xs)
            .background(badgeColor.opacity(0.15))
            .foregroundColor(badgeColor)
            .clipShape(Capsule())
            .accessibilityLabel("Status: \(status)")
    }

    var badgeColor: Color {
        switch status.lowercased() {
        case "upcoming", "booked", "active", "confirmed":
            return .wellnessTeal
        case "pending", "paused", "on hold", "rescheduled":
            return .wellnessGold
        case "cancelled", "failed", "expired", "rejected", "inactive":
            return .wellnessError
        case "completed", "done", "past", "paid", "success":
            return .wellnessTeal
        case "refunded", "partial":
            return .wellnessBlush
        default:
            return .wellnessMuted
        }
    }
}

import Foundation

struct AppNotification: Identifiable, Equatable {
    let id: String
    let type: NotificationType
    let title: String
    let body: String
    let screen: String?
    let entityId: String?
    var isRead: Bool
    let receivedAt: Date

    enum NotificationType: String {
        case appointment = "appointment"
        case prescription = "prescription"
        case billing = "billing"
        case loyalty = "loyalty"
        case membership = "membership"
        case general = "general"
        case promotion = "promotion"
    }

    var iconName: String {
        switch type {
        case .appointment: return "calendar.badge.clock"
        case .prescription: return "cross.case.fill"
        case .billing: return "creditcard"
        case .loyalty: return "star.circle.fill"
        case .membership: return "person.badge.shield.checkmark"
        case .general: return "bell.fill"
        case .promotion: return "tag.fill"
        }
    }

    var formattedTime: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: receivedAt, relativeTo: Date())
    }
}

enum NotificationRouteMapper {
    static func canonicalScreen(from rawValue: String?) -> String? {
        guard let rawValue else { return nil }
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let screenName: String
        if let url = URL(string: trimmed), url.scheme != nil {
            screenName = firstPathSegment(in: url.pathComponents) ?? url.lastPathComponent
        } else if trimmed.hasPrefix("/") {
            screenName = firstPathSegment(in: trimmed) ?? trimmed
        } else {
            screenName = firstPathSegment(in: trimmed) ?? trimmed
        }

        switch screenName {
        case "dashboard": return "dashboard"
        case "appointments", "myAppointments": return "appointments"
        case "book": return "book"
        case "visitHistory", "visit_history": return "visitHistory"
        case "waitlist": return "waitlist"
        case "prescriptions": return "prescriptions"
        case "prescription", "prescription_pdf": return "prescription"
        case "prescription_analysis": return "prescription_analysis"
        case "treatmentPlans", "treatment_plans": return "treatmentPlans"
        case "consentForms", "consent_forms": return "consentForms"
        case "wallet": return "wallet"
        case "giftCards", "gift_cards": return "giftCards"
        case "memberships": return "memberships"
        case "profile": return "profile"
        case "notifications": return "notifications"
        case "notificationSettings", "notification_settings": return "notificationSettings"
        case "catalog": return "catalog"
        case "finance": return "finance"
        case "loyalty": return "loyalty"
        default: return nil
        }
    }

    private static func firstPathSegment(in rawPath: String) -> String? {
        let pathWithoutQuery = rawPath
            .split(whereSeparator: { $0 == "?" || $0 == "#" })
            .first
            .map(String.init) ?? rawPath
        return pathWithoutQuery
            .split(separator: "/")
            .first
            .map(String.init)
    }

    private static func firstPathSegment(in components: [String]) -> String? {
        components.first { !$0.isEmpty && $0 != "/" }
    }
}

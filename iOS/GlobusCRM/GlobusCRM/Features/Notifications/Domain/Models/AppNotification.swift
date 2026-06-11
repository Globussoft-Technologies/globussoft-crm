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

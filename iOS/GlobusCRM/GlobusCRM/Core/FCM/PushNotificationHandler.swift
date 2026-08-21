import UserNotifications
import Foundation

final class PushNotificationHandler: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushNotificationHandler()
    private let notificationDAO = NotificationDAO()

    // Show notifications when app is in foreground
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        persist(notification.request.content.userInfo)
        completionHandler([.banner, .badge, .sound])
    }

    // Handle tap on notification
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        persist(userInfo)
        let rawDestination = userInfo["screen"] as? String ?? userInfo["link"] as? String
        if let rawDestination {
            let entityId = stringify(userInfo["entityId"] ?? userInfo["id"])
            if let url = DeepLinkHandler.url(screenOrLink: rawDestination, entityId: entityId) {
                NotificationCenter.default.post(name: .handleDeepLink, object: url)
            }
        }
        completionHandler()
    }

    private func persist(_ userInfo: [AnyHashable: Any]) {
        guard let id = stringify(userInfo["id"] ?? userInfo["notificationId"]) else { return }
        let rawScreen = userInfo["screen"] as? String ?? userInfo["link"] as? String
        let item = AppNotification(
            id: id,
            type: notificationType(userInfo["type"] as? String),
            title: userInfo["title"] as? String ?? "Notification",
            body: userInfo["body"] as? String ?? userInfo["message"] as? String ?? "",
            screen: NotificationRouteMapper.canonicalScreen(from: rawScreen),
            entityId: stringify(userInfo["entityId"]),
            isRead: false,
            receivedAt: date(from: userInfo["createdAt"] as? String) ?? Date()
        )
        notificationDAO.save(notification: item)
        NotificationCenter.default.post(name: .pushNotificationReceived, object: item)
    }

    private func notificationType(_ rawValue: String?) -> AppNotification.NotificationType {
        let value = (rawValue ?? "").lowercased()
        if value.contains("appointment") || value.contains("booking") { return .appointment }
        if value.contains("prescription") || value.contains("treatment") { return .prescription }
        if value.contains("wallet") || value.contains("payment") || value.contains("billing") { return .billing }
        if value.contains("loyalty") { return .loyalty }
        if value.contains("membership") { return .membership }
        if value.contains("promotion") || value.contains("offer") { return .promotion }
        return .general
    }

    private func date(from value: String?) -> Date? {
        guard let value else { return nil }
        return ISO8601DateFormatter().date(from: value)
    }

    // FCM type → notification channel (iOS: UNNotificationCategory equivalent)
    func resolveCategory(for type: String) -> String {
        switch type {
        case "APPOINTMENT_REMINDER_24H", "APPOINTMENT_REMINDER_1H",
             "BOOKING_CONFIRMED", "BOOKING_CANCELLED":
            return "wellness_reminders"
        case "WALLET_CREDITED":
            return "wellness_wallet"
        case "NPS_SURVEY", "NO_SHOW_REENGAGEMENT":
            return "wellness_offers"
        default:
            return "wellness_health"
        }
    }

    private func stringify(_ value: Any?) -> String? {
        switch value {
        case let value as String: return value
        case let value as Int: return String(value)
        case let value as NSNumber: return value.stringValue
        default: return nil
        }
    }
}

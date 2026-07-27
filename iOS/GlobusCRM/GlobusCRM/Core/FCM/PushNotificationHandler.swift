import UserNotifications
import Foundation

final class PushNotificationHandler: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushNotificationHandler()

    // Show notifications when app is in foreground
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .badge, .sound])
    }

    // Handle tap on notification
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        let rawDestination = userInfo["screen"] as? String ?? userInfo["link"] as? String
        if let rawDestination {
            let entityId = stringify(userInfo["entityId"] ?? userInfo["id"])
            if let url = DeepLinkHandler.url(screenOrLink: rawDestination, entityId: entityId) {
                NotificationCenter.default.post(name: .handleDeepLink, object: url)
            }
        }
        completionHandler()
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

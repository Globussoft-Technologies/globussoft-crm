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
        if let screen = userInfo["screen"] as? String {
            let entityId = userInfo["entityId"] as? String
            var urlString = "wellnesspatient://screen/\(screen)"
            if let id = entityId { urlString += "?id=\(id)" }
            if let url = URL(string: urlString) {
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
}

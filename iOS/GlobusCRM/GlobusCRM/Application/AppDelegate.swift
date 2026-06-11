import UIKit
import UserNotifications
import CoreText

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        registerCustomFonts()

        UNUserNotificationCenter.current().delegate = PushNotificationHandler.shared
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }
        return true
    }

    private func registerCustomFonts() {
        let fontFiles = ["Poppins-Regular", "Poppins-Medium", "Poppins-SemiBold", "Poppins-Bold"]
        for name in fontFiles {
            // Xcode may flatten bundle resources or preserve the Fonts/ subfolder
            let url = Bundle.main.url(forResource: name, withExtension: "ttf")
                   ?? Bundle.main.url(forResource: name, withExtension: "ttf", subdirectory: "Fonts")
            guard let fontURL = url else { continue }
            CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil)
        }
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        KeychainManager().saveAPNsToken(token)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Non-fatal — app works without push notifications
    }
}

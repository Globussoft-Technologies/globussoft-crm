import Foundation

// APNs-based push token manager — no Firebase dependency.
// Upgrade path: add FirebaseMessaging SDK, uncomment MessagingDelegate conformance.
final class APNsManager {
    static let shared = APNsManager()
    private let keychain = KeychainManager()

    func getToken() -> String? { keychain.getAPNsToken() }
}

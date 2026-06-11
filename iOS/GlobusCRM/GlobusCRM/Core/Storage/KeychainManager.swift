import Foundation
import Security

final class KeychainManager {
    private enum Keys {
        static let token = "wellness.token"
        static let patientId = "wellness.patientId"
        static let patientName = "wellness.patientName"
        static let patientEmail = "wellness.patientEmail"
        static let patientPhone = "wellness.patientPhone"
        static let apnsToken = "wellness.apnsToken"
    }

    // MARK: - Auth token
    func saveToken(_ token: String) { save(key: Keys.token, value: token) }
    func getToken() -> String? { get(key: Keys.token) }
    func deleteToken() { delete(key: Keys.token) }

    // MARK: - Patient ID (stored as string, Int convenience for legacy endpoints)
    func savePatientId(_ id: Int) { save(key: Keys.patientId, value: String(id)) }
    func getPatientId() -> Int? { get(key: Keys.patientId).flatMap { Int($0) } }
    func getPatientIdString() -> String? { get(key: Keys.patientId) }

    // MARK: - Patient info
    func savePatientName(_ name: String) { save(key: Keys.patientName, value: name) }
    func getPatientName() -> String? { get(key: Keys.patientName) }
    func setName(_ name: String) { savePatientName(name) }

    func savePatientEmail(_ email: String) { save(key: Keys.patientEmail, value: email) }
    func getPatientEmail() -> String? { get(key: Keys.patientEmail) }

    func savePatientPhone(_ phone: String) { save(key: Keys.patientPhone, value: phone) }
    func getPatientPhone() -> String? { get(key: Keys.patientPhone) }

    // MARK: - APNs token (replaces FCM token)
    func saveAPNsToken(_ token: String) { save(key: Keys.apnsToken, value: token) }
    func getAPNsToken() -> String? { get(key: Keys.apnsToken) }

    // MARK: - Clear all
    func clearAll() {
        [Keys.token, Keys.patientId, Keys.patientName,
         Keys.patientEmail, Keys.patientPhone, Keys.apnsToken].forEach { delete(key: $0) }
    }

    // MARK: - Private Keychain helpers
    private func save(key: String, value: String) {
        let data = Data(value.utf8)
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: key,
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock
        ]
        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }

    private func get(key: String) -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: key,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func delete(key: String) {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrAccount: key]
        SecItemDelete(query as CFDictionary)
    }
}

import Foundation

final class AuthInterceptor {
    private let keychainManager: KeychainManager

    init(keychainManager: KeychainManager) {
        self.keychainManager = keychainManager
    }

    func apply(to request: inout URLRequest) {
        if let token = keychainManager.getToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }
}

import Foundation
import Combine

@MainActor
final class SessionManager: ObservableObject {
    enum AuthState {
        case unknown
        case authenticated
        case unauthenticated
    }

    @Published var authState: AuthState = .unknown

    func setAuthenticated() { authState = .authenticated }
    func setUnauthenticated() { authState = .unauthenticated }

    func handleUnauthorized() {
        authState = .unauthenticated
    }
}

import Foundation
import Combine

@MainActor
final class AppContainer: ObservableObject {
    // MARK: - Core services
    let keychainManager = KeychainManager()
    let userDefaultsManager = UserDefaultsManager()

    // MARK: - Global state holders
    let sessionManager: SessionManager
    let appRouter: AppRouter
    let appState: AppState
    let apiClient: WellnessAPIClient

    // MARK: - Feature containers (lazy — avoid allocation until first use)
    lazy var authContainer     = AuthFeatureContainer(container: self)
    lazy var dashboardContainer = DashboardFeatureContainer(container: self)
    lazy var bookingContainer  = BookingFeatureContainer(container: self)
    lazy var healthContainer   = HealthFeatureContainer(container: self)
    lazy var membershipContainer = MembershipFeatureContainer(container: self)
    lazy var walletContainer   = WalletFeatureContainer(container: self)
    lazy var financeContainer  = FinanceFeatureContainer(container: self)
    lazy var catalogContainer  = CatalogFeatureContainer(container: self)
    lazy var loyaltyContainer  = LoyaltyFeatureContainer(container: self)
    lazy var profileContainer  = ProfileFeatureContainer(container: self)
    lazy var notificationsContainer = NotificationsFeatureContainer(container: self)

    init() {
        self.sessionManager = SessionManager()
        self.appRouter = AppRouter()
        self.appState = AppState(userDefaultsManager: userDefaultsManager)
        self.apiClient = WellnessAPIClient(keychainManager: keychainManager,
                                           sessionManager: sessionManager)
    }
}

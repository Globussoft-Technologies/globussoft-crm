import SwiftUI
import Combine

@MainActor
final class AppState: ObservableObject {
    @Published var isDarkTheme: Bool
    @Published var clinicName: String
    @Published var brandColor: Color
    @Published var logoUrl: String?
    @Published var unreadNotificationCount: Int = 0
    @Published var permissions: Set<String> = []

    private let userDefaultsManager: UserDefaultsManager

    init(userDefaultsManager: UserDefaultsManager) {
        self.userDefaultsManager = userDefaultsManager
        self.isDarkTheme = userDefaultsManager.isDarkTheme
        self.clinicName = userDefaultsManager.clinicName
        self.brandColor = BrandColorResolver.parse(hex: userDefaultsManager.brandColor)
        self.logoUrl = userDefaultsManager.logoUrl
    }

    func toggleDarkTheme() {
        isDarkTheme.toggle()
        userDefaultsManager.isDarkTheme = isDarkTheme
    }

    func updateBranding(name: String, colorHex: String?, logoUrl: String?) {
        clinicName = name
        brandColor = BrandColorResolver.parse(hex: colorHex)
        self.logoUrl = logoUrl
        userDefaultsManager.clinicName = name
        userDefaultsManager.brandColor = colorHex
        userDefaultsManager.logoUrl = logoUrl
    }

    func hasPermission(_ permission: String) -> Bool {
        permissions.contains(permission)
    }

    func setPermissions(_ perms: [String]) {
        permissions = Set(perms)
    }

    func clearPermissions() {
        permissions = []
    }
}

import SwiftUI
import Combine

enum AppThemePreference: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "System"
        case .light:  return "Light"
        case .dark:   return "Dark"
        }
    }

    var icon: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light:  return "sun.max.fill"
        case .dark:   return "moon.fill"
        }
    }
}

@MainActor
final class AppState: ObservableObject {
    @Published var themePreference: AppThemePreference
    @Published var clinicName: String
    @Published var brandColor: Color
    @Published var logoUrl: String?
    @Published var unreadNotificationCount: Int = 0
    @Published var permissions: Set<String> = []

    private let userDefaultsManager: UserDefaultsManager

    init(userDefaultsManager: UserDefaultsManager) {
        self.userDefaultsManager = userDefaultsManager
        self.themePreference = userDefaultsManager.themePreference
        self.clinicName = userDefaultsManager.clinicName
        self.brandColor = BrandColorResolver.parse(hex: userDefaultsManager.brandColor)
        self.logoUrl = userDefaultsManager.logoUrl
    }

    var preferredColorScheme: ColorScheme? {
        switch themePreference {
        case .system: return nil
        case .light:  return .light
        case .dark:   return .dark
        }
    }

    func resolvedIsDark(systemColorScheme: ColorScheme) -> Bool {
        switch themePreference {
        case .system: return systemColorScheme == .dark
        case .light:  return false
        case .dark:   return true
        }
    }

    func setThemePreference(_ preference: AppThemePreference) {
        themePreference = preference
        userDefaultsManager.themePreference = preference
    }

    func toggleDarkTheme() {
        setThemePreference(themePreference == .dark ? .light : .dark)
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

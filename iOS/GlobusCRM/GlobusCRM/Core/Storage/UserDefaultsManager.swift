import Foundation

final class UserDefaultsManager {
    private enum Keys {
        static let isDarkTheme = "wellness.isDarkTheme"
        static let themePreference = "wellness.themePreference"
        static let clinicName = "wellness.clinicName"
        static let brandColor = "wellness.brandColor"
        static let logoUrl = "wellness.logoUrl"
    }

    var themePreference: AppThemePreference {
        get {
            if let raw = UserDefaults.standard.string(forKey: Keys.themePreference),
               let preference = AppThemePreference(rawValue: raw) {
                return preference
            }
            if UserDefaults.standard.object(forKey: Keys.isDarkTheme) != nil {
                return UserDefaults.standard.bool(forKey: Keys.isDarkTheme) ? .dark : .light
            }
            return .system
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: Keys.themePreference) }
    }

    var isDarkTheme: Bool {
        get { UserDefaults.standard.bool(forKey: Keys.isDarkTheme) }
        set { UserDefaults.standard.set(newValue, forKey: Keys.isDarkTheme) }
    }

    var clinicName: String {
        get { UserDefaults.standard.string(forKey: Keys.clinicName) ?? "WellnessCRM" }
        set { UserDefaults.standard.set(newValue, forKey: Keys.clinicName) }
    }

    var brandColor: String? {
        get { UserDefaults.standard.string(forKey: Keys.brandColor) }
        set { UserDefaults.standard.set(newValue, forKey: Keys.brandColor) }
    }

    var logoUrl: String? {
        get { UserDefaults.standard.string(forKey: Keys.logoUrl) }
        set { UserDefaults.standard.set(newValue, forKey: Keys.logoUrl) }
    }

    func clearBranding() {
        [Keys.clinicName, Keys.brandColor, Keys.logoUrl].forEach {
            UserDefaults.standard.removeObject(forKey: $0)
        }
    }
}

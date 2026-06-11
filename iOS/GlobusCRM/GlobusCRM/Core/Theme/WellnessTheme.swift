import SwiftUI

struct WellnessThemeEnvironment {
    var primaryColor: Color
    var isDarkMode: Bool

    static let `default` = WellnessThemeEnvironment(
        primaryColor: .wellnessTeal,
        isDarkMode: false
    )
}

private struct WellnessThemeKey: EnvironmentKey {
    static let defaultValue = WellnessThemeEnvironment.default
}

extension EnvironmentValues {
    var wellnessTheme: WellnessThemeEnvironment {
        get { self[WellnessThemeKey.self] }
        set { self[WellnessThemeKey.self] = newValue }
    }
}

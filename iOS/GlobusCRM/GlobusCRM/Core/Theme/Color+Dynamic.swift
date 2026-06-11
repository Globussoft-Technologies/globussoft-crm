import SwiftUI

extension Color {
    static var wellnessBackground: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.08, green: 0.10, blue: 0.10, alpha: 1)
                : UIColor(red: 0.98, green: 0.96, blue: 0.95, alpha: 1)
        })
    }

    static var wellnessSurface: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.12, green: 0.14, blue: 0.14, alpha: 1)
                : UIColor.white
        })
    }

    static var wellnessOnSurface: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor.white : UIColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1)
        })
    }

    static var wellnessMuted: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.55, green: 0.60, blue: 0.60, alpha: 1)
                : UIColor(red: 0.45, green: 0.50, blue: 0.50, alpha: 1)
        })
    }

    /// Subtle border / stroke colour — adapts to light / dark
    static var wellnessStroke: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(white: 1.0, alpha: 0.12)
                : UIColor(white: 0.0, alpha: 0.10)
        })
    }

    /// Destructive / error semantic colour
    static let wellnessError = Color(UIColor.systemRed)
}

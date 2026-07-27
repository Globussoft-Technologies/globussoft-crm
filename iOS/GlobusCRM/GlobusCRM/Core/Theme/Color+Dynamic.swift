import SwiftUI

extension Color {
    static var wellnessBackground: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(hex: "#141210")!
                : UIColor(hex: "#F5F1E8")!
        })
    }

    static var wellnessSurface: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(hex: "#1D1A15")!
                : UIColor(hex: "#FAF6EE")!
        })
    }

    static var wellnessOnSurface: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(hex: "#E7E2D5")!
                : UIColor(hex: "#1C1B16")!
        })
    }

    static var wellnessMuted: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(hex: "#CBC3AE")!
                : UIColor(hex: "#4A4638")!
        })
    }

    /// Subtle border / stroke colour — adapts to light / dark
    static var wellnessStroke: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(hex: "#4A4536")!
                : UIColor(hex: "#DDD6C4")!
        })
    }

    /// Destructive / error semantic colour
    static let wellnessError = Color(dynamicLight: "#BA1A1A", dark: "#FFB4AB")
}

import SwiftUI

extension Color {
    // Android parity: Dr. Enhance Wellness uses gold, warm silver, and onyx.
    static let wellnessTeal      = Color(dynamicLight: "#8A6D23", dark: "#F0C75E")
    static let wellnessTealDark  = Color(dynamicLight: "#3D2E00", dark: "#8A6D23")
    static let wellnessBlush     = Color(dynamicLight: "#6E6656", dark: "#D8D0BC")
    static let wellnessCream     = Color(dynamicLight: "#F5F1E8", dark: "#141210")
    static let wellnessDiamond   = Color(hex: "#1D4ED8") ?? Color.blue
    static let wellnessGold      = Color(dynamicLight: "#D4AF37", dark: "#F0C75E")
    static let wellnessGoldContainer = Color(dynamicLight: "#F5DFA0", dark: "#8A6D23")
    static let wellnessPlatinum  = Color(dynamicLight: "#6E6656", dark: "#D8D0BC")
    static let wellnessSlate     = Color(dynamicLight: "#3A362E", dark: "#C9C3B3")
    static let wellnessSuccess   = Color(hex: "#3F8F6C") ?? Color.green
    static let wellnessInfo      = Color(hex: "#3B6FA0") ?? Color.blue

    // Gift card background palette (used for decorative tile gradients)
    static let wellnessCardEarth  = Color(hex: "#5D4037") ?? Color.brown
    static let wellnessCardNavy   = Color(hex: "#1A237E") ?? Color.blue
    static let wellnessCardViolet = Color(hex: "#4A148C") ?? Color.purple
    static let wellnessCardRose   = Color(hex: "#880E4F") ?? Color.pink

    init?(hex: String) {
        var h = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if h.hasPrefix("#") { h.removeFirst() }
        guard h.count == 6, let rgb = UInt64(h, radix: 16) else { return nil }
        self.init(
            red:   Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8)  & 0xFF) / 255,
            blue:  Double(rgb & 0xFF)         / 255
        )
    }

    init?(hex: String, opacity: Double) {
        self.init(hex: hex)
        // opacity applied via .opacity() at call site
    }

    init(dynamicLight lightHex: String, dark darkHex: String) {
        let light = UIColor(hex: lightHex) ?? UIColor.label
        let dark = UIColor(hex: darkHex) ?? UIColor.label
        self.init(UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
    }
}

extension UIColor {
    convenience init?(hex: String) {
        var h = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if h.hasPrefix("#") { h.removeFirst() }
        guard h.count == 6, let rgb = UInt64(h, radix: 16) else { return nil }
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}

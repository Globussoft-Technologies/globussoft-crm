import SwiftUI

extension Color {
    static let wellnessTeal      = Color(hex: "#265855") ?? Color.teal
    static let wellnessTealDark  = Color(hex: "#1a3d3a") ?? Color.teal
    static let wellnessBlush     = Color(hex: "#CD9481") ?? Color.pink
    static let wellnessCream     = Color(hex: "#F9F5F1") ?? Color(UIColor.systemBackground)
    static let wellnessDiamond   = Color(hex: "#1D4ED8") ?? Color.blue
    static let wellnessGold      = Color(hex: "#F59E0B") ?? Color.yellow
    static let wellnessPlatinum  = Color(hex: "#374151") ?? Color.gray
    static let wellnessSlate     = Color(hex: "#1F2937") ?? Color.gray

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
}

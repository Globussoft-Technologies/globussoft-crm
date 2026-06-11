import SwiftUI

struct BrandColorResolver {
    static func parse(hex: String?) -> Color {
        guard let hex, let color = Color(hex: hex) else { return .wellnessTeal }
        return color
    }
}

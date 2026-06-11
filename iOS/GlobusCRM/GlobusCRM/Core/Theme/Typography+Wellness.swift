import SwiftUI

extension Font {
    static func poppins(_ weight: Font.Weight = .regular, size: CGFloat, relativeTo textStyle: Font.TextStyle = .body) -> Font {
        let name: String
        switch weight {
        case .bold:     name = "Poppins-Bold"
        case .semibold: name = "Poppins-SemiBold"
        case .medium:   name = "Poppins-Medium"
        default:        name = "Poppins-Regular"
        }
        return .custom(name, size: size, relativeTo: textStyle)
    }

    static var wellnessLargeTitle:   Font { poppins(.bold,     size: 28, relativeTo: .largeTitle) }
    static var wellnessTitle:        Font { poppins(.semibold, size: 22, relativeTo: .title) }
    static var wellnessTitle2:       Font { poppins(.semibold, size: 18, relativeTo: .title2) }
    static var wellnessTitle3:       Font { poppins(.semibold, size: 16, relativeTo: .title3) }
    static var wellnessHeadline:     Font { poppins(.semibold, size: 16, relativeTo: .headline) }
    static var wellnessSubheadline:  Font { poppins(.medium,   size: 15, relativeTo: .subheadline) }
    static var wellnessBody:         Font { poppins(.regular,  size: 15, relativeTo: .body) }
    static var wellnessCallout:      Font { poppins(.medium,   size: 14, relativeTo: .callout) }
    static var wellnessCaption:      Font { poppins(.regular,  size: 12, relativeTo: .caption) }
    static var wellnessCaption2:     Font { poppins(.regular,  size: 11, relativeTo: .caption2) }
}

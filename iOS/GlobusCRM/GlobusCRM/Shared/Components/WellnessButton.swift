import SwiftUI

enum WellnessButtonStyle {
    case primary, secondary, ghost, destructive
}

// MARK: - Press animation style

private struct WellnessButtonPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? AppAnimation.pressScale : 1)
            .animation(AppAnimation.spring, value: configuration.isPressed)
    }
}

// MARK: - Button component

struct WellnessButton: View {
    let title: String
    let style: WellnessButtonStyle
    let isLoading: Bool
    let action: () -> Void

    @Environment(\.wellnessTheme) private var theme
    @Environment(\.isEnabled) private var isEnabled

    init(_ title: String,
         style: WellnessButtonStyle = .primary,
         isLoading: Bool = false,
         action: @escaping () -> Void) {
        self.title = title
        self.style = style
        self.isLoading = isLoading
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: WellnessSpacing.sm) {
                if isLoading {
                    ProgressView()
                        .tint(textColor)
                        .controlSize(.small)
                }
                Text(title)
                    .font(.wellnessCallout)
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: Layout.minTapTarget)
            .padding(.horizontal, Layout.cardPadding)
            .background(background)
            .foregroundColor(textColor)
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
            .overlay(
                RoundedRectangle(cornerRadius: WellnessRadius.medium)
                    .stroke(borderColor, lineWidth: style == .secondary ? 1.5 : 0)
            )
            .opacity((!isEnabled || isLoading) ? 0.5 : 1)
        }
        .buttonStyle(WellnessButtonPressStyle())
        .disabled(isLoading)
        .accessibilityLabel(title)
    }

    private var background: Color {
        switch style {
        case .primary:     return theme.primaryColor
        case .secondary:   return .clear
        case .ghost:       return .clear
        case .destructive: return .wellnessError
        }
    }

    private var textColor: Color {
        switch style {
        case .primary:     return .white
        case .secondary:   return theme.primaryColor
        case .ghost:       return theme.primaryColor
        case .destructive: return .white
        }
    }

    private var borderColor: Color {
        switch style {
        case .secondary: return theme.primaryColor.opacity(0.6)
        default:         return .clear
        }
    }
}

#Preview {
    VStack(spacing: WellnessSpacing.lg) {
        WellnessButton("Primary") {}
        WellnessButton("Secondary", style: .secondary) {}
        WellnessButton("Ghost", style: .ghost) {}
        WellnessButton("Destructive", style: .destructive) {}
        WellnessButton("Loading", isLoading: true) {}
        WellnessButton("Disabled") {}.disabled(true)
    }
    .padding()
}

import SwiftUI

struct WellnessTextField: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    var error: String?              = nil
    var isSecure: Bool              = false
    var keyboardType: UIKeyboardType = .default
    var autocapitalization: TextInputAutocapitalization = .sentences
    var submitLabel: SubmitLabel    = .done

    @State private var isSecureVisible = false
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
            Text(label)
                .font(.wellnessCaption)
                .fontWeight(.medium)
                .foregroundColor(isFocused ? .wellnessTeal : .wellnessMuted)
                .animation(AppAnimation.fast, value: isFocused)

            HStack(spacing: WellnessSpacing.sm) {
                Group {
                    if isSecure && !isSecureVisible {
                        SecureField(placeholder, text: $text)
                    } else {
                        TextField(placeholder, text: $text)
                            .keyboardType(keyboardType)
                    }
                }
                .font(.wellnessBody)
                .foregroundColor(.wellnessOnSurface)
                .autocorrectionDisabled(keyboardType == .emailAddress || isSecure)
                .textInputAutocapitalization(keyboardType == .emailAddress ? .never : autocapitalization)
                .submitLabel(submitLabel)
                .focused($isFocused)

                if isSecure {
                    Button {
                        isSecureVisible.toggle()
                    } label: {
                        Image(systemName: isSecureVisible ? Symbols.eyeSlash : Symbols.eye)
                            .font(.system(size: IconSize.badge))
                            .foregroundColor(.wellnessMuted)
                            .frame(width: Layout.minTapTarget, height: Layout.minTapTarget)
                    }
                    .accessibilityLabel(isSecureVisible ? "Hide password" : "Show password")
                }
            }
            .padding(.horizontal, WellnessSpacing.md)
            .padding(.vertical, WellnessSpacing.md)
            .background(Color.wellnessSurface)
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
            .overlay(
                RoundedRectangle(cornerRadius: WellnessRadius.small)
                    .stroke(strokeColor, lineWidth: isFocused ? 1.5 : 1)
                    .animation(AppAnimation.fast, value: isFocused)
            )

            if let error {
                Label(error, systemImage: Symbols.errorTriangle)
                    .font(.wellnessCaption)
                    .foregroundColor(.wellnessError)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(AppAnimation.fast, value: error)
    }

    private var strokeColor: Color {
        if error != nil  { return .wellnessError }
        if isFocused     { return .wellnessTeal }
        return .wellnessStroke
    }
}

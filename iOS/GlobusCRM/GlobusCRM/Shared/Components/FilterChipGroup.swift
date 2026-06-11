import SwiftUI

struct FilterChipGroup: View {
    let options: [String]
    @Binding var selected: String
    var onSelect: ((String) -> Void)? = nil

    @Environment(\.wellnessTheme) private var theme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: WellnessSpacing.sm) {
                ForEach(options, id: \.self) { option in
                    FilterChip(
                        title: option,
                        isSelected: selected == option,
                        primaryColor: theme.primaryColor
                    ) {
                        withAnimation(AppAnimation.fast) {
                            selected = option
                        }
                        onSelect?(option)
                    }
                }
            }
            .padding(.horizontal, Layout.pagePadding)
            .padding(.vertical, WellnessSpacing.xs)
        }
    }
}

private struct FilterChip: View {
    let title: String
    let isSelected: Bool
    let primaryColor: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.wellnessCaption)
                .fontWeight(isSelected ? .semibold : .regular)
                .padding(.horizontal, WellnessSpacing.lg)
                .padding(.vertical, WellnessSpacing.sm)
                .background(isSelected ? primaryColor : Color.wellnessSurface)
                .foregroundColor(isSelected ? .white : .wellnessOnSurface)
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .stroke(isSelected ? Color.clear : Color.wellnessStroke, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

#Preview {
    @State var selected = "All"
    return FilterChipGroup(
        options: ["All", "Wallet", "Gift Cards", "Memberships", "Treatments"],
        selected: $selected
    )
    .padding(.vertical)
}

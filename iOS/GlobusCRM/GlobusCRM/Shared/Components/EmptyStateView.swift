import SwiftUI

struct EmptyStateView: View {
    let icon: String
    let title: String
    let subtitle: String
    var actionTitle: String?    = nil
    var action: (() -> Void)?   = nil

    var body: some View {
        VStack(spacing: WellnessSpacing.lg) {
            Image(systemName: icon)
                .font(.system(size: IconSize.empty))
                .foregroundColor(.wellnessMuted)

            VStack(spacing: WellnessSpacing.xs) {
                Text(title)
                    .font(.wellnessHeadline)
                    .foregroundColor(.wellnessOnSurface)

                Text(subtitle)
                    .font(.wellnessBody)
                    .foregroundColor(.wellnessMuted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, WellnessSpacing.xxl)
            }

            if let actionTitle, let action {
                WellnessButton(actionTitle, action: action)
                    .frame(maxWidth: 220)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Layout.pagePadding)
    }
}

#Preview {
    EmptyStateView(
        icon: Symbols.calendarBadge,
        title: "No appointments",
        subtitle: "Book your first appointment to get started.",
        actionTitle: "Book Now"
    ) {}
}

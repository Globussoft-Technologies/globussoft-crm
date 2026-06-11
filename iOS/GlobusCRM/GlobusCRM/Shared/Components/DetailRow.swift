import SwiftUI

/// Shared label-value row for detail sheets.
/// Renders as `Label (muted callout) ··· Value (medium, onSurface, trailing)`.
/// Used inside `WellnessSurface`-background VStacks (Visit, Payment, Wallet, Appointment details).
struct DetailRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.wellnessCallout)
                .foregroundColor(.wellnessMuted)
            Spacer(minLength: WellnessSpacing.md)
            Text(value)
                .font(.wellnessCallout)
                .fontWeight(.medium)
                .foregroundColor(.wellnessOnSurface)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, Layout.cardPadding)
        .padding(.vertical, WellnessSpacing.md)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }
}

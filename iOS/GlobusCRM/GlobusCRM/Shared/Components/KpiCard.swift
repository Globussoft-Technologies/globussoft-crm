import SwiftUI

struct KpiCard: View {
    let label: String
    let value: String
    var icon: String?         = nil
    var iconColor: Color      = .wellnessTeal

    var body: some View {
        WellnessCard {
            VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: IconSize.small))
                        .foregroundColor(iconColor)
                }

                Text(value)
                    .font(.wellnessTitle2)
                    .fontWeight(.bold)
                    .foregroundColor(.wellnessOnSurface)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)

                Text(label)
                    .font(.wellnessCaption)
                    .foregroundColor(.wellnessMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Layout.cardPadding)
        }
    }
}

#Preview {
    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())],
              spacing: Layout.itemSpacing) {
        KpiCard(label: "Wallet",     value: "₹1,200",   icon: Symbols.wallet)
        KpiCard(label: "Membership", value: "Active",   icon: Symbols.memberBadge, iconColor: .wellnessBlush)
        KpiCard(label: "Loyalty",    value: "450 pts",  icon: Symbols.star,        iconColor: .wellnessGold)
    }
    .padding()
}

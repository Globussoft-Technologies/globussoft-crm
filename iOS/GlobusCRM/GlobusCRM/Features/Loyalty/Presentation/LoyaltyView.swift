import SwiftUI

struct LoyaltyView: View {
    @StateObject var viewModel: LoyaltyViewModel

    var body: some View {
        ScrollView {
            VStack(spacing: WellnessSpacing.xl) {
                if !viewModel.hasLoaded {
                    SkeletonListView(count: 3, cardHeight: 120)
                } else if let balance = viewModel.balance {
                    loyaltyCard(balance: balance)

                    if !viewModel.transactions.isEmpty {
                        VStack(alignment: .leading, spacing: WellnessSpacing.md) {
                            SectionLabel(title: "Transaction History")
                                .padding(.horizontal, Layout.pagePadding)

                            LazyVStack(spacing: 1) {
                                ForEach(viewModel.transactions) { tx in
                                    LoyaltyTransactionRow(transaction: tx)
                                }
                            }
                            .background(Color.wellnessSurface)
                            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
                            .padding(.horizontal, Layout.pagePadding)
                        }
                    }
                } else if let err = viewModel.error {
                    ErrorStateView(message: err) { Task { await viewModel.load() } }
                } else {
                    EmptyStateView(
                        icon: Symbols.star,
                        title: "No Loyalty Data",
                        subtitle: "Earn points by booking appointments and completing visits."
                    )
                }
            }
            .padding(.vertical, WellnessSpacing.lg)
        }
        .background(Color.wellnessBackground.ignoresSafeArea())
        .navigationTitle("Loyalty Points")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.load() }
        .refreshable { await viewModel.load() }
    }

    @ViewBuilder
    private func loyaltyCard(balance: LoyaltyBalance) -> some View {
        VStack(spacing: WellnessSpacing.lg) {
            HStack {
                VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                    Text("Loyalty Points")
                        .font(.wellnessCaption)
                        .foregroundColor(.white.opacity(0.85))
                    Text("\(balance.points)")
                        .font(.system(.largeTitle, design: .rounded).weight(.bold))
                        .foregroundColor(.white)
                        .contentTransition(.numericText())
                        .accessibilityLabel("\(balance.points) loyalty points")
                    Text("points")
                        .font(.wellnessCaption)
                        .foregroundColor(.white.opacity(0.8))
                }
                Spacer()
                Image(systemName: "star.circle.fill")
                    .font(.system(size: IconSize.hero))
                    .foregroundColor(.white.opacity(0.3))
                    .accessibilityHidden(true)
            }

            if balance.earnedThisMonth > 0 {
                HStack {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.callout)
                        .foregroundColor(.white.opacity(0.9))
                        .accessibilityHidden(true)
                    Text("Earned this month: \(balance.earnedThisMonth) pts")
                        .font(.wellnessCaption)
                        .foregroundColor(.white.opacity(0.9))
                    Spacer()
                }
                .padding(.horizontal, WellnessSpacing.md)
                .padding(.vertical, WellnessSpacing.sm)
                .background(Color.white.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
            }
        }
        .padding(Layout.cardPaddingLarge)
        .background(
            LinearGradient(colors: [Color.wellnessGold, Color.wellnessGold.opacity(0.7)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
        .shadow(color: Color.wellnessGold.opacity(0.4), radius: 12, x: 0, y: 4)
        .padding(.horizontal, Layout.pagePadding)
    }
}

struct LoyaltyTransactionRow: View {
    let transaction: LoyaltyTransaction

    var isPositive: Bool {
        transaction.type == .earned || transaction.type == .bonus
    }

    private var accentColor: Color { isPositive ? .wellnessTeal : .wellnessError }

    var body: some View {
        HStack(spacing: WellnessSpacing.md) {
            Image(systemName: isPositive ? "plus.circle.fill" : "minus.circle.fill")
                .foregroundColor(accentColor)
                .font(.system(size: IconSize.medium))
                .frame(width: 36)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                MarqueeText(
                    text: transaction.description.isEmpty
                        ? transaction.type.rawValue.capitalized
                        : transaction.description,
                    font: .wellnessSubheadline,
                    foregroundColor: .wellnessOnSurface
                )
                Text(DateUtil.formatDate(iso: transaction.date))
                    .font(.wellnessCaption2)
                    .foregroundColor(.wellnessMuted)
            }

            Spacer()

            Text((isPositive ? "+" : "") + "\(transaction.points) pts")
                .font(.wellnessSubheadline)
                .foregroundColor(accentColor)
                .accessibilityLabel(
                    (isPositive ? "Earned" : "Spent") + " \(transaction.points) points"
                )
        }
        .padding(.horizontal, Layout.pagePadding)
        .padding(.vertical, WellnessSpacing.md)
    }
}

import SwiftUI

struct WalletView: View {
    @ObservedObject var viewModel: WalletViewModel
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var router: AppRouter
    @State private var selectedTransaction: WalletTransaction?

    var body: some View {
        ScrollView {
            VStack(spacing: WellnessSpacing.xl) {
                if let err = viewModel.error {
                    ErrorBanner(message: err)
                }
                balanceCard
                giftCardsButton
                if viewModel.hasLoaded && !viewModel.transactions.isEmpty {
                    statsGrid
                }
                filterRow
                transactionsList
            }
            .padding(Layout.pagePadding)
        }
        .background(Color.wellnessBackground.ignoresSafeArea())
        .navigationTitle("My Wallet")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.load() }
        .refreshable { await viewModel.load() }
        .sheet(item: $selectedTransaction) { tx in
            TransactionDetailSheet(transaction: tx)
        }
    }

    private var giftCardsButton: some View {
        Button {
            router.navigate(to: .giftCards)
        } label: {
            HStack(spacing: WellnessSpacing.sm) {
                Image(systemName: "gift.fill")
                    .font(.system(size: IconSize.badge, weight: .medium))
                    .foregroundColor(.wellnessBlush)
                Text("Gift Cards")
                    .font(.wellnessSubheadline)
                    .fontWeight(.medium)
                    .foregroundColor(.wellnessOnSurface)
                Spacer()
                Text("Buy & redeem")
                    .font(.wellnessCaption)
                    .foregroundColor(.wellnessMuted)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.wellnessMuted)
            }
            .padding(.horizontal, Layout.cardPadding)
            .padding(.vertical, WellnessSpacing.md)
            .background(Color.wellnessSurface)
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
        }
        .buttonStyle(.plain)
    }

    private var statsGrid: some View {
        LazyVGrid(
            columns: [GridItem(.flexible()), GridItem(.flexible())],
            spacing: Layout.itemSpacing
        ) {
            KpiCard(label: "Total Paid",
                    value: CurrencyUtil.formatAmount(viewModel.totalPaid, currency: viewModel.statsCurrency),
                    icon: "checkmark.circle.fill",
                    iconColor: .wellnessTeal)
            KpiCard(label: "Pending",
                    value: CurrencyUtil.formatAmount(viewModel.totalPending, currency: viewModel.statsCurrency),
                    icon: "clock.fill",
                    iconColor: .wellnessGold)
            KpiCard(label: "Gift Cards",
                    value: CurrencyUtil.formatAmount(viewModel.giftCardsTotal, currency: viewModel.statsCurrency),
                    icon: "gift.fill",
                    iconColor: .wellnessBlush)
            KpiCard(label: "Memberships",
                    value: CurrencyUtil.formatAmount(viewModel.membershipsTotal, currency: viewModel.statsCurrency),
                    icon: "checkmark.seal.fill",
                    iconColor: .wellnessMuted)
        }
    }

    @ViewBuilder
    private var balanceCard: some View {
        if let balance = viewModel.balance {
            VStack(spacing: WellnessSpacing.sm) {
                Text("Available Balance")
                    .font(.wellnessCaption)
                    .foregroundColor(.white.opacity(0.8))
                Text(CurrencyUtil.formatAmount(balance.balance, currency: balance.currency))
                    .font(.system(.largeTitle, design: .rounded).weight(.bold))
                    .foregroundColor(.white)
                if balance.pendingCredits > 0 {
                    Text("\(CurrencyUtil.formatAmount(balance.pendingCredits, currency: balance.currency)) pending")
                        .font(.wellnessCaption)
                        .foregroundColor(.white.opacity(0.7))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(WellnessSpacing.xxl)
            .background(
                LinearGradient(colors: [.wellnessTeal, .wellnessTealDark],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
            )
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
            .shadow(color: Color.wellnessTeal.opacity(0.3), radius: 12, x: 0, y: 4)
        }
    }

    private var filterRow: some View {
        FilterChipGroup(
            options: TransactionFilterType.allCases.map { $0.rawValue },
            selected: Binding(
                get: { viewModel.selectedFilter.rawValue },
                set: { viewModel.setFilter(TransactionFilterType(rawValue: $0) ?? .all) }
            )
        )
    }

    @ViewBuilder
    private var transactionsList: some View {
        if !viewModel.hasLoaded {
            SkeletonListView(count: 4, cardHeight: 60)
        } else if viewModel.filteredTransactions.isEmpty {
            EmptyStateView(icon: "creditcard", title: "No Transactions", subtitle: "Your wallet transactions will appear here.")
        } else {
            LazyVStack(spacing: 1) {
                ForEach(viewModel.filteredTransactions) { tx in
                    Button { selectedTransaction = tx } label: {
                        WalletTransactionRow(transaction: tx)
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(Color.wellnessSurface)
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
        }
    }
}

struct WalletTransactionRow: View {
    let transaction: WalletTransaction

    var isCredit: Bool {
        transaction.type == .credit
    }

    private var accentColor: Color { isCredit ? .wellnessTeal : .wellnessError }

    var body: some View {
        HStack(spacing: WellnessSpacing.md) {
            Image(systemName: isCredit ? "arrow.down.circle.fill" : "arrow.up.circle.fill")
                .foregroundColor(accentColor)
                .font(.system(size: IconSize.medium))
                .frame(width: 36)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                MarqueeText(
                    text: transaction.description,
                    font: .wellnessSubheadline,
                    foregroundColor: .wellnessOnSurface
                )
                Text(DateUtil.formatDate(iso: transaction.date))
                    .font(.wellnessCaption2)
                    .foregroundColor(.wellnessMuted)
            }

            Spacer()

            Text((isCredit ? "+" : "-") + CurrencyUtil.formatAmount(transaction.amount, currency: transaction.currency))
                .font(.wellnessSubheadline)
                .foregroundColor(accentColor)
                .accessibilityLabel(
                    (isCredit ? "Credit" : "Debit") + " " +
                    CurrencyUtil.formatAmount(transaction.amount, currency: transaction.currency)
                )
        }
        .padding(.horizontal, Layout.pagePadding)
        .padding(.vertical, WellnessSpacing.md)
    }
}

// MARK: - Transaction Detail Sheet

private struct TransactionDetailSheet: View {
    let transaction: WalletTransaction
    @Environment(\.dismiss) private var dismiss

    private var isCredit: Bool {
        transaction.type == .credit
    }

    private var typeIcon: String {
        switch transaction.type {
        case .credit: return "arrow.down.circle.fill"
        case .debit:  return "arrow.up.circle.fill"
        }
    }

    private var typeColor: Color {
        isCredit ? .wellnessTeal : .wellnessError
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: WellnessSpacing.lg) {
                    ZStack {
                        Circle()
                            .fill(typeColor.opacity(0.12))
                            .frame(width: 64, height: 64)
                        Image(systemName: typeIcon)
                            .font(.system(size: IconSize.accent))
                            .foregroundColor(typeColor)
                    }
                    .padding(.top, WellnessSpacing.lg)

                    Text((isCredit ? "+" : "-") + CurrencyUtil.formatAmount(transaction.amount, currency: transaction.currency))
                        .font(.system(.largeTitle, design: .default).weight(.bold))
                        .foregroundColor(typeColor)

                    VStack(spacing: 0) {
                        DetailRow(label: "Description", value: transaction.description)
                        Divider().padding(.leading, Layout.cardPadding)
                        DetailRow(label: "Type", value: transaction.type.rawValue.capitalized)
                        Divider().padding(.leading, Layout.cardPadding)
                        DetailRow(label: "Date", value: DateUtil.formatDate(iso: transaction.date))
                        Divider().padding(.leading, Layout.cardPadding)
                        DetailRow(label: "Status", value: transaction.status.capitalized)
                    }
                    .background(Color.wellnessSurface)
                    .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
                    .padding(.horizontal, Layout.pagePadding)
                }
                .padding(.bottom, WellnessSpacing.xl)
            }
            .background(Color.wellnessBackground.ignoresSafeArea())
            .navigationTitle("Transaction Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }

}


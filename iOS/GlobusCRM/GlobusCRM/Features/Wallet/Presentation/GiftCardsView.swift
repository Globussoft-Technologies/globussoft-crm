import SwiftUI
import Combine

private enum GiftCardActiveSheet: Identifiable {
    case history, redeem
    var id: Self { self }
}

struct GiftCardsView: View {
    @ObservedObject var viewModel: GiftCardsViewModel
    @State private var activeSheet: GiftCardActiveSheet? = nil
    @State private var showBuyAlert = false

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        Group {
            if !viewModel.hasLoaded {
                SkeletonListView(count: 4, cardHeight: 160)
            } else if !viewModel.storefrontCards.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: WellnessSpacing.xl) {
                        header
                        LazyVGrid(columns: columns, spacing: WellnessSpacing.md) {
                            ForEach(viewModel.storefrontCards) { card in
                                StorefrontGiftCardTile(card: card) {
                                    showBuyAlert = true
                                }
                            }
                        }
                    }
                    .padding(Layout.pagePadding)
                    .padding(.bottom, WellnessSpacing.xl)
                }
            } else if let error = viewModel.loadError {
                ScrollView {
                    VStack(spacing: WellnessSpacing.xl) {
                        header
                        ErrorStateView(message: error) {
                            Task { await viewModel.load() }
                        }
                    }
                    .padding(Layout.pagePadding)
                }
            } else {
                ScrollView {
                    VStack(spacing: WellnessSpacing.xl) {
                        header
                        EmptyStateView(
                            icon: "giftcard",
                            title: "No Gift Cards Available",
                            subtitle: "Gift cards will appear here when published by the clinic."
                        )
                    }
                    .padding(Layout.pagePadding)
                }
            }
        }
        .background(Color.wellnessBackground.ignoresSafeArea())
        .navigationTitle("Gift Cards")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    activeSheet = .redeem
                } label: {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: IconSize.toolbar))
                }
                .accessibilityLabel("Redeem gift card code")
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    activeSheet = .history
                } label: {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: IconSize.toolbar))
                }
                .accessibilityLabel("Purchase history")
            }
        }
        .task { if !viewModel.hasLoaded { await viewModel.load() } }
        .refreshable { await viewModel.load() }
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .history:
                GiftCardHistorySheet(ownedCards: viewModel.ownedCards)
            case .redeem:
                RedeemGiftCardSheet(viewModel: viewModel)
            }
        }
        .alert("Purchase on Web", isPresented: $showBuyAlert) {
            Button("Got it", role: .cancel) { }
        } message: {
            Text("Gift card purchases are completed on our website. Please visit the web portal to buy a gift card.")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
            Text("Gift Cards")
                .font(.wellnessHeadline)
                .fontWeight(.bold)
                .foregroundColor(.wellnessOnSurface)
            Text("Give the gift of wellness — redeemable for any service or session.")
                .font(.wellnessBody)
                .foregroundColor(.wellnessMuted)
        }
    }
}

// MARK: - Storefront Tile

private struct StorefrontGiftCardTile: View {
    let card: GiftCard
    let onBuy: () -> Void

    private var cardColor: Color {
        if let hex = card.color { return Color(hex: hex) ?? .wellnessTeal }
        return cardColorFromId(card.id)
    }

    private func cardColorFromId(_ id: String) -> Color {
        let palette: [Color] = [
            .wellnessTeal,
            .wellnessCardEarth,
            .wellnessCardNavy,
            .wellnessCardViolet,
            .wellnessCardRose
        ]
        return palette[(Int(id) ?? 0) % palette.count]
    }

    var body: some View {
        LinearGradient(
            colors: [cardColor, cardColor.opacity(0.78)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
        .overlay(alignment: .center) {
            VStack(alignment: .leading, spacing: 0) {
                // Top row: gift icon left, e-Gift badge right
                HStack {
                    Image(systemName: "giftcard.fill")
                        .font(.system(size: IconSize.small, weight: .medium))
                        .foregroundColor(.white.opacity(0.85))
                        .accessibilityHidden(true)
                    Spacer()
                    HStack(spacing: 3) {
                        Image(systemName: "sparkles")
                            .font(.system(.caption2).weight(.semibold))
                            .accessibilityHidden(true)
                        Text("e-Gift")
                            .font(.poppins(.semibold, size: 10, relativeTo: .caption2))
                    }
                    .foregroundColor(.white)
                    .padding(.horizontal, WellnessSpacing.sm)
                    .padding(.vertical, WellnessSpacing.xs)
                    .background(Color.white.opacity(0.22))
                    .clipShape(Capsule())
                }

                Spacer(minLength: WellnessSpacing.sm)

                // Card name — prominent, own row
                Text(card.name)
                    .font(.poppins(.bold, size: 15, relativeTo: .subheadline))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .truncationMode(.tail)

                // Amount
                Text(CurrencyUtil.formatAmount(card.amount, currency: card.currency))
                    .font(.system(.title2, design: .rounded).weight(.heavy))
                    .foregroundColor(.white)
                    .padding(.top, 2)

                // Validity
                Text("Valid \(card.validityDays) days")
                    .font(.wellnessCaption2)
                    .foregroundColor(.white.opacity(0.72))

                Spacer(minLength: WellnessSpacing.sm)

                // Buy button — white background, card-color text
                Button(action: onBuy) {
                    Text("Buy Now")
                        .font(.wellnessCallout)
                        .fontWeight(.bold)
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: Layout.minTapTarget)
                        .background(Color.white)
                        .foregroundColor(cardColor)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            .padding(WellnessSpacing.md)
        }
        .frame(height: 190)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(card.name), \(CurrencyUtil.formatAmount(card.amount, currency: card.currency))")
    }
}

// MARK: - History Sheet

private struct GiftCardHistorySheet: View {
    let ownedCards: [GiftCard]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if ownedCards.isEmpty {
                    EmptyStateView(
                        icon: "clock.arrow.circlepath",
                        title: "No Purchase History",
                        subtitle: "Gift cards you purchase will appear here."
                    )
                } else {
                    List {
                        ForEach(ownedCards) { card in
                            PurchasedCardRow(card: card)
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(
                                    top: WellnessSpacing.xs,
                                    leading: Layout.pagePadding,
                                    bottom: WellnessSpacing.xs,
                                    trailing: Layout.pagePadding
                                ))
                        }
                    }
                    .listStyle(.plain)
                    .wellnessListBackground()
                }
            }
            .background(Color.wellnessBackground.ignoresSafeArea())
            .navigationTitle("Purchase History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct PurchasedCardRow: View {
    let card: GiftCard

    private var statusLabel: String {
        guard let s = card.paymentStatus else { return "Paid" }
        return s.uppercased() == "PENDING" ? "Pending" : "Paid"
    }

    private var statusColor: Color {
        guard let s = card.paymentStatus else { return .wellnessTeal }
        return s.uppercased() == "PENDING" ? .wellnessGold : .wellnessTeal
    }

    var body: some View {
        WellnessCard {
            HStack(spacing: WellnessSpacing.md) {
                ZStack {
                    RoundedRectangle(cornerRadius: WellnessRadius.small)
                        .fill(Color.wellnessTeal.opacity(0.12))
                        .frame(width: 40, height: 40)
                    Image(systemName: "giftcard.fill")
                        .font(.system(size: IconSize.badge))
                        .foregroundColor(.wellnessTeal)
                        .accessibilityHidden(true)
                }

                VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                    Text(card.name)
                        .font(.wellnessSubheadline)
                        .fontWeight(.medium)
                        .foregroundColor(.wellnessOnSurface)
                    if let purchasedAt = card.purchasedAt, !purchasedAt.isEmpty {
                        Text("Purchased \(DateUtil.formatDate(iso: purchasedAt))")
                            .font(.wellnessCaption2)
                            .foregroundColor(.wellnessMuted)
                    }
                }

                Spacer()

                VStack(alignment: .trailing, spacing: WellnessSpacing.xs) {
                    Text(CurrencyUtil.formatAmount(card.amount, currency: card.currency))
                        .font(.wellnessSubheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(.wellnessOnSurface)
                    StatusPill(label: statusLabel, color: statusColor)
                }
            }
            .padding(Layout.cardPadding)
        }
    }
}

private struct StatusPill: View {
    let label: String
    let color: Color

    var body: some View {
        Text(label)
            .font(.wellnessCaption2)
            .fontWeight(.semibold)
            .foregroundColor(color)
            .padding(.horizontal, WellnessSpacing.sm)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }
}

// MARK: - Redeem Sheet

struct RedeemGiftCardSheet: View {
    @ObservedObject var viewModel: GiftCardsViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: WellnessSpacing.xl) {
                Text("Enter the gift card code you received to add the balance to your wallet.")
                    .font(.wellnessBody)
                    .foregroundColor(.wellnessMuted)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Layout.pagePadding)
                    .padding(.top, WellnessSpacing.sm)

                WellnessTextField(
                    label: "Gift Card Code",
                    placeholder: "e.g. GIFT-XXXX-XXXX",
                    text: $code
                )
                .padding(.horizontal, Layout.pagePadding)

                if let error = viewModel.redeemError {
                    Text(error)
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessError)
                        .padding(.horizontal, Layout.pagePadding)
                }

                WellnessButton("Redeem", isLoading: viewModel.isRedeeming) {
                    Task { await viewModel.redeem(code: code, onSuccess: { dismiss() }) }
                }
                .padding(.horizontal, Layout.pagePadding)
                .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty)

                Spacer()
            }
            .padding(.top, WellnessSpacing.lg)
            .background(Color.wellnessBackground.ignoresSafeArea())
            .navigationTitle("Redeem Gift Card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - ViewModel

@MainActor
final class GiftCardsViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var hasLoaded = false
    @Published var storefrontCards: [GiftCard] = []   // available to buy
    @Published var ownedCards: [GiftCard] = []         // purchase history
    @Published var loadError: String? = nil
    @Published var isRedeeming = false
    @Published var redeemError: String? = nil
    @Published var redeemSuccess = false

    private let getStorefrontUseCase: GetGiftCardStorefrontUseCase
    private let getGiftCardsUseCase: GetGiftCardsUseCase
    private let redeemGiftCardUseCase: RedeemGiftCardUseCase
    private let keychain: KeychainManager

    init(getStorefrontUseCase: GetGiftCardStorefrontUseCase,
         getGiftCardsUseCase: GetGiftCardsUseCase,
         redeemGiftCardUseCase: RedeemGiftCardUseCase,
         keychain: KeychainManager) {
        self.getStorefrontUseCase = getStorefrontUseCase
        self.getGiftCardsUseCase = getGiftCardsUseCase
        self.redeemGiftCardUseCase = redeemGiftCardUseCase
        self.keychain = keychain
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        loadError = nil
        async let storefrontResult = getStorefrontUseCase()
        let patientId = keychain.getPatientIdString() ?? ""
        async let ownedResult = getGiftCardsUseCase(patientId: patientId)
        let (storefront, owned) = await (storefrontResult, ownedResult)
        hasLoaded = true
        switch storefront {
        case .success(let cards): storefrontCards = cards
        case .failure(let e): loadError = e.localizedDescription
        }
        if case .success(let cards) = owned { ownedCards = cards }
    }

    func redeem(code: String, onSuccess: () -> Void) async {
        guard let patientId = keychain.getPatientIdString() else { return }
        isRedeeming = true
        redeemError = nil
        let result = await redeemGiftCardUseCase(code: code, patientId: patientId)
        isRedeeming = false
        switch result {
        case .success:
            redeemSuccess = true
            onSuccess()
        case .failure(let error):
            redeemError = error.localizedDescription
        }
    }
}

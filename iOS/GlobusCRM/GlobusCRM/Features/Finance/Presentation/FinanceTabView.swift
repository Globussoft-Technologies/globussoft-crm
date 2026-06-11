import SwiftUI

struct FinanceTabView: View {
    // Plain lets — FinanceTabView only routes these to child views and
    // never reads their properties, so observing them would cause this
    // view to rebuild on every child ViewModel publish, which resets
    // @State in the inner TabView (selectedPayment, selectedTransaction)
    // and auto-dismisses any open sheet.
    let walletViewModel: WalletViewModel
    let giftCardsViewModel: GiftCardsViewModel
    let paymentsViewModel: PaymentsViewModel
    @State private var selectedSegment = 0

    var body: some View {
        VStack(spacing: 0) {
            Picker("Finance", selection: $selectedSegment) {
                Text("Payments").tag(0)
                Text("Wallet").tag(1)
                Text("Gift Cards").tag(2)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Layout.pagePadding)
            .padding(.vertical, WellnessSpacing.sm)
            .background(Color.wellnessSurface)

            ZStack {
                if selectedSegment == 0 {
                    PaymentsView(viewModel: paymentsViewModel)
                        .transition(.opacity)
                } else if selectedSegment == 1 {
                    WalletView(viewModel: walletViewModel)
                        .transition(.opacity)
                } else {
                    GiftCardsView(viewModel: giftCardsViewModel)
                        .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.18), value: selectedSegment)
        }
        .background(Color.wellnessBackground)
        .navigationTitle("Finance")
        .navigationBarTitleDisplayMode(.large)
    }
}

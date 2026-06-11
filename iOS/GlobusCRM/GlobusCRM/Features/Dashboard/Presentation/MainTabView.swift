import SwiftUI

struct MainTabView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var container: AppContainer

    var body: some View {
        TabView(selection: Binding(
            get: { router.selectedTab },
            set: { tapped in
                if tapped == router.selectedTab {
                    router.popCurrentTabToRoot()
                } else {
                    // Always land at the root when switching to a different tab
                    router.clearTabPath(for: tapped)
                    router.selectedTab = tapped
                }
            }
        )) {
            HomeTab()
                .tabItem { Label(TabRoute.home.title, systemImage: TabRoute.home.icon) }
                .tag(TabRoute.home)
                .badge(appState.unreadNotificationCount > 0 ? "\(appState.unreadNotificationCount)" : nil)

            BookingsTab()
                .tabItem { Label(TabRoute.bookings.title, systemImage: TabRoute.bookings.icon) }
                .tag(TabRoute.bookings)

            CatalogTab()
                .tabItem { Label(TabRoute.catalog.title, systemImage: TabRoute.catalog.icon) }
                .tag(TabRoute.catalog)

            FinanceTab()
                .tabItem { Label(TabRoute.finance.title, systemImage: TabRoute.finance.icon) }
                .tag(TabRoute.finance)

            ProfileTab()
                .tabItem { Label(TabRoute.profile.title, systemImage: TabRoute.profile.icon) }
                .tag(TabRoute.profile)
        }
        .tint(appState.brandColor)
        .sheet(item: $router.presentedSheet) { sheet in
            GlobalSheetView(sheet: sheet)
        }
    }
}

// MARK: - Home Tab

struct HomeTab: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var container: AppContainer

    var body: some View {
        NavigationStack(path: $router.homePath) {
            DashboardView(viewModel: container.dashboardContainer.dashboardViewModel)
                .navigationDestination(for: AppRoute.self) { route in
                    homeDestination(for: route)
                }
        }
    }

    @ViewBuilder
    private func homeDestination(for route: AppRoute) -> some View {
        switch route {
        case .prescriptions:
            PrescriptionsView(viewModel: container.healthContainer.prescriptionsViewModel)
        case .treatmentPlans:
            TreatmentPlansView(viewModel: container.healthContainer.treatmentPlansViewModel)
        case .consentForms:
            ConsentFormsView(viewModel: container.healthContainer.consentFormsViewModel)
        case .memberships:
            MembershipView(viewModel: container.membershipContainer.membershipViewModel)
        case .loyalty:
            LoyaltyView(viewModel: container.loyaltyContainer.loyaltyViewModel)
        case .bookAppointment:
            BookAppointmentView(viewModel: container.bookingContainer.bookAppointmentViewModel)
        case .notificationInbox:
            NotificationInboxView(viewModel: container.notificationsContainer.notificationInboxViewModel)
        default:
            EmptyView()
        }
    }
}

// MARK: - Bookings Tab

struct BookingsTab: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var container: AppContainer

    var body: some View {
        NavigationStack(path: $router.bookingsPath) {
            MyAppointmentsView(viewModel: container.bookingContainer.myAppointmentsViewModel)
                .navigationDestination(for: AppRoute.self) { route in
                    bookingsDestination(for: route)
                }
        }
    }

    @ViewBuilder
    private func bookingsDestination(for route: AppRoute) -> some View {
        switch route {
        case .visitHistory:
            VisitHistoryView(viewModel: container.bookingContainer.visitHistoryViewModel)
        case .waitlist:
            WaitlistView(viewModel: container.bookingContainer.waitlistViewModel)
        case .bookAppointment:
            BookAppointmentView(viewModel: container.bookingContainer.bookAppointmentViewModel)
        case .notificationInbox:
            NotificationInboxView(viewModel: container.notificationsContainer.notificationInboxViewModel)
        default:
            EmptyView()
        }
    }
}

// MARK: - Catalog Tab

struct CatalogTab: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var container: AppContainer

    var body: some View {
        NavigationStack(path: $router.catalogPath) {
            CatalogTabView(
                viewModel: container.catalogContainer.catalogViewModel,
                membershipViewModel: container.membershipContainer.membershipViewModel
            )
            .navigationDestination(for: AppRoute.self) { route in
                if case .bookAppointment = route {
                    BookAppointmentView(viewModel: container.bookingContainer.bookAppointmentViewModel)
                } else {
                    EmptyView()
                }
            }
        }
    }
}

// MARK: - Finance Tab

struct FinanceTab: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var container: AppContainer

    var body: some View {
        NavigationStack(path: $router.financePath) {
            FinanceTabView(
                walletViewModel: container.walletContainer.walletViewModel,
                giftCardsViewModel: container.walletContainer.giftCardsViewModel,
                paymentsViewModel: container.financeContainer.paymentsViewModel
            )
            .navigationDestination(for: AppRoute.self) { route in
                financeDestination(for: route)
            }
        }
    }

    @ViewBuilder
    private func financeDestination(for route: AppRoute) -> some View {
        switch route {
        case .wallet:
            WalletView(viewModel: container.walletContainer.walletViewModel)
        case .giftCards:
            GiftCardsView(viewModel: container.walletContainer.giftCardsViewModel)
        default:
            EmptyView()
        }
    }
}

// MARK: - Profile Tab

struct ProfileTab: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var container: AppContainer

    var body: some View {
        NavigationStack(path: $router.profilePath) {
            ProfileView(viewModel: container.profileContainer.profileViewModel)
                .navigationDestination(for: AppRoute.self) { route in
                    profileDestination(for: route)
                }
        }
    }

    @ViewBuilder
    private func profileDestination(for route: AppRoute) -> some View {
        switch route {
        case .notificationSettings:
            NotificationSettingsView(viewModel: container.profileContainer.notificationSettingsViewModel)
        case .notificationInbox:
            NotificationInboxView(viewModel: container.notificationsContainer.notificationInboxViewModel)
        default:
            EmptyView()
        }
    }
}

// MARK: - Global Sheet Renderer

struct GlobalSheetView: View {
    let sheet: AppSheet
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var container: AppContainer

    var body: some View {
        switch sheet {
        case .visitDetail(let id):
            VisitDetailSheet(visitId: id)
        case .membershipPlanDetail(let id):
            MembershipPlanDetailSheet(planId: id)
        case .transactionReceipt(let id):
            TransactionReceiptSheet(transactionId: id)
        case .giftCardBuyConfirm(let id):
            GiftCardBuyConfirmSheet(giftCardId: id)
        case .prescriptionDownloadConfirm(let id):
            PrescriptionDownloadConfirmSheet(prescriptionId: id)
        case .serviceDetail:
            EmptyView()
        case .rescheduleAppointment, .addWaitlist:
            EmptyView() // Handled locally within feature views
        }
    }
}

// MARK: - Sheet views

struct VisitDetailSheet: View {
    let visitId: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Text("Visit #\(visitId)")
                .navigationTitle("Visit Detail")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.large])
    }
}

struct MembershipPlanDetailSheet: View {
    let planId: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Text("Plan #\(planId)")
                .navigationTitle("Membership Plan")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.medium])
    }
}

struct TransactionReceiptSheet: View {
    let transactionId: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Text("Receipt #\(transactionId)")
                .navigationTitle("Receipt")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.medium])
    }
}

struct GiftCardBuyConfirmSheet: View {
    let giftCardId: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: WellnessSpacing.xl) {
                Image(systemName: Symbols.giftCard)
                    .font(.system(size: IconSize.hero))
                    .foregroundColor(.wellnessTeal)

                Text("Purchase Gift Card")
                    .font(.wellnessTitle)
                    .foregroundColor(.wellnessOnSurface)

                Text("Payment integration will complete this purchase.")
                    .font(.wellnessBody)
                    .foregroundColor(.wellnessMuted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, WellnessSpacing.xl)

                WellnessButton("Close") { dismiss() }
                    .padding(.horizontal, Layout.pagePadding)
            }
            .padding(Layout.pagePadding)
            .navigationTitle("Buy Gift Card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium])
    }
}

struct PrescriptionDownloadConfirmSheet: View {
    let prescriptionId: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: WellnessSpacing.xl) {
                Image(systemName: Symbols.prescription)
                    .font(.system(size: IconSize.hero))
                    .foregroundColor(.wellnessTeal)

                Text("Download Prescription PDF?")
                    .font(.wellnessTitle)
                    .foregroundColor(.wellnessOnSurface)

                Text("The PDF will be saved to your Files app.")
                    .font(.wellnessBody)
                    .foregroundColor(.wellnessMuted)

                WellnessButton("Download") { dismiss() }
                    .padding(.horizontal, Layout.pagePadding)
            }
            .padding(Layout.pagePadding)
            .navigationTitle("Download")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium])
    }
}

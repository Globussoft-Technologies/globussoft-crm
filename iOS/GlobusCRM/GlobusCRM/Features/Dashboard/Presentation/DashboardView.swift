import SwiftUI

struct DashboardView: View {
    @StateObject var viewModel: DashboardViewModel
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var router: AppRouter

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Layout.sectionSpacing) {
                greetingHeader
                if let err = viewModel.uiState.error {
                    ErrorBanner(message: err)
                }
                statsRow
                todayAtAGlance
                nextAppointmentSection
                portalMenu
            }
            .padding(Layout.pagePadding)
            .padding(.bottom, WellnessSpacing.xl)
        }
        .background(Color.wellnessBackground)
        .navigationTitle(appState.clinicName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { notificationBell }
        .task { viewModel.onEvent(.refresh) }
        .refreshable { viewModel.onEvent(.refresh) }
        .overlay {
            if viewModel.uiState.isLoading { LoadingView() }
        }
    }

    // MARK: - Greeting

    private var greetingHeader: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
            Text(greeting)
                .font(.wellnessBody)
                .foregroundColor(.wellnessMuted)
            Text(viewModel.uiState.patientName.isEmpty ? "Patient" : viewModel.uiState.patientName)
                .font(.wellnessTitle)
                .fontWeight(.bold)
                .foregroundColor(.wellnessOnSurface)
        }
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        switch hour {
        case 5..<12:  return "Good morning,"
        case 12..<17: return "Good afternoon,"
        default:      return "Good evening,"
        }
    }

    // MARK: - Stats

    private var statsRow: some View {
        LazyVGrid(
            columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())],
            spacing: Layout.itemSpacing
        ) {
            Button { router.navigate(to: .wallet) } label: {
                KpiCard(label: "Wallet",
                        value: viewModel.uiState.walletBalance.map { CurrencyUtil.formatINR($0) } ?? "—",
                        icon: "wallet.pass.fill")
            }
            .buttonStyle(CardPressStyle())

            Button { router.navigate(to: .memberships) } label: {
                KpiCard(label: "Membership",
                        value: viewModel.uiState.membershipStatus ?? "—",
                        icon: "checkmark.seal.fill",
                        iconColor: .wellnessBlush)
            }
            .buttonStyle(CardPressStyle())

            Button { router.navigate(to: .loyalty) } label: {
                KpiCard(label: "Loyalty",
                        value: viewModel.uiState.loyaltyPoints.map { "\($0) pts" } ?? "—",
                        icon: "star.fill",
                        iconColor: .wellnessGold)
            }
            .buttonStyle(CardPressStyle())
        }
    }

    // MARK: - Today At A Glance

    @ViewBuilder
    private var todayAtAGlance: some View {
        if let appt = viewModel.uiState.nextAppointment, isToday(appt.appointmentDate) {
            VStack(alignment: .leading, spacing: WellnessSpacing.md) {
                SectionLabel(title: "Today at a Glance")
                WellnessCard {
                    HStack(spacing: WellnessSpacing.md) {
                        ZStack {
                            Circle()
                                .fill(Color.wellnessTeal.opacity(0.12))
                                .frame(width: 44, height: 44)
                            Image(systemName: "calendar.day.timeline.left")
                                .font(.system(size: IconSize.small))
                                .foregroundColor(.wellnessTeal)
                        }
                        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                            Text("1 appointment today")
                                .font(.wellnessHeadline)
                                .foregroundColor(.wellnessOnSurface)
                            MarqueeText(
                                text: appt.serviceName ?? "Appointment",
                                font: .wellnessCaption,
                                foregroundColor: .wellnessMuted
                            )
                        }
                        Spacer(minLength: 0)
                        Text(DateUtil.formatAppointment(iso: appt.appointmentDate))
                            .font(.wellnessCaption2)
                            .fontWeight(.semibold)
                            .foregroundColor(.wellnessTeal)
                            .multilineTextAlignment(.trailing)
                    }
                    .padding(Layout.cardPadding)
                }
            }
        }
    }

    private func isToday(_ isoDate: String) -> Bool {
        DateUtil.isToday(iso: isoDate)
    }

    // MARK: - Next Appointment

    private var nextAppointmentSection: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.md) {
            SectionLabel(title: "Next Appointment")

            if let appt = viewModel.uiState.nextAppointment {
                WellnessCard {
                    HStack(spacing: WellnessSpacing.md) {
                        ZStack {
                            Circle()
                                .fill(appState.brandColor.opacity(0.12))
                                .frame(width: 48, height: 48)
                            Image(systemName: "calendar.badge.clock")
                                .font(.system(size: IconSize.small))
                                .foregroundColor(appState.brandColor)
                        }
                        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                            MarqueeText(
                                text: appt.serviceName ?? "Appointment",
                                font: .wellnessHeadline,
                                foregroundColor: .wellnessOnSurface
                            )
                            if let doctor = appt.doctorName {
                                MarqueeText(
                                    text: doctor,
                                    font: .wellnessBody,
                                    foregroundColor: .wellnessMuted
                                )
                            }
                            Text(DateUtil.formatAppointment(iso: appt.appointmentDate))
                                .font(.wellnessCaption)
                                .foregroundColor(.wellnessMuted)
                        }
                        Spacer(minLength: 0)
                        StatusBadge(status: appt.status.capitalized)
                    }
                    .padding(Layout.cardPadding)
                }
            } else {
                WellnessCard {
                    HStack(spacing: WellnessSpacing.md) {
                        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                            Text("No upcoming appointments")
                                .font(.wellnessSubheadline)
                                .foregroundColor(.wellnessOnSurface)
                            Text("Book one now to get started")
                                .font(.wellnessCaption)
                                .foregroundColor(.wellnessMuted)
                        }
                        Spacer()
                        WellnessButton("Book Now", style: .secondary) {
                            router.selectedTab = .bookings
                        }
                        .fixedSize()
                    }
                    .padding(Layout.cardPadding)
                }
            }
        }
    }

    // MARK: - Portal Menu

    private var portalMenu: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.lg) {
            // Appointments
            MenuSection(title: "Appointments", icon: "calendar", color: .wellnessTeal) {
                MenuTile(icon: "calendar.badge.plus", title: "Book", subtitle: "New appointment", color: .wellnessTeal) {
                    router.navigate(to: .bookAppointment())
                }
                MenuTile(icon: "calendar", title: "My Bookings", subtitle: "Upcoming & past", color: .wellnessTeal) {
                    router.selectedTab = .bookings
                }
                MenuTile(icon: "clock.arrow.circlepath", title: "Visit History", subtitle: "All visits", color: .wellnessTeal) {
                    router.navigate(to: .visitHistory)
                }
                MenuTile(icon: "person.badge.clock", title: "Waitlist", subtitle: "Join queue", color: .wellnessTeal) {
                    router.navigate(to: .waitlist)
                }
            }

            // Clinical
            MenuSection(title: "Clinical", icon: "cross.case.fill", color: .wellnessBlush) {
                MenuTile(icon: "pills.fill", title: "Prescriptions", subtitle: "View & download", color: .wellnessBlush) {
                    router.navigate(to: .prescriptions)
                }
                MenuTile(icon: "list.clipboard.fill", title: "Treatment Plans", subtitle: "Care programs", color: .wellnessBlush) {
                    router.navigate(to: .treatmentPlans)
                }
                MenuTile(icon: "doc.text.fill", title: "Consent Forms", subtitle: "Signed forms", color: .wellnessBlush) {
                    router.navigate(to: .consentForms)
                }
            }

            // Finance
            MenuSection(title: "Finance", icon: "creditcard.fill", color: .wellnessGold) {
                MenuTile(icon: "wallet.pass.fill", title: "Wallet", subtitle: "Balance & top-up", color: .wellnessGold) {
                    router.navigate(to: .wallet)
                }
                MenuTile(icon: "gift.fill", title: "Gift Cards", subtitle: "Buy & redeem", color: .wellnessGold) {
                    router.navigate(to: .giftCards)
                }
                MenuTile(icon: "creditcard.fill", title: "Payments", subtitle: "Transaction history", color: .wellnessGold) {
                    router.selectedTab = .finance
                }
            }

            // Catalog
            MenuSection(title: "Catalog", icon: "square.grid.2x2.fill", color: appState.brandColor) {
                MenuTile(icon: "square.grid.2x2.fill", title: "Services", subtitle: "Browse catalog", color: appState.brandColor) {
                    router.selectedTab = .catalog
                }
                MenuTile(icon: "checkmark.seal.fill", title: "Memberships", subtitle: "Plans & perks", color: appState.brandColor) {
                    router.navigate(to: .memberships)
                }
                MenuTile(icon: "star.fill", title: "Loyalty", subtitle: "Points & rewards", color: appState.brandColor) {
                    router.navigate(to: .loyalty)
                }
            }

            // Account
            MenuSection(title: "Account", icon: "person.circle.fill", color: .wellnessMuted) {
                MenuTile(icon: "person.circle.fill", title: "Profile", subtitle: "Personal details", color: .wellnessMuted) {
                    router.selectedTab = .profile
                }
                MenuTile(icon: "bell.fill", title: "Notifications", subtitle: "Alerts & updates", color: .wellnessMuted) {
                    router.navigate(to: .notificationInbox)
                }
            }
        }
    }

    // MARK: - Toolbar

    private var notificationBell: some ToolbarContent {
        ToolbarItem(placement: .navigationBarTrailing) {
            Button {
                router.navigate(to: .notificationInbox)
            } label: {
                Image(systemName: appState.unreadNotificationCount > 0 ? "bell.badge.fill" : "bell.fill")
                    .font(.system(size: IconSize.toolbar))
                    .foregroundColor(.wellnessOnSurface)
                    .symbolRenderingMode(appState.unreadNotificationCount > 0 ? .multicolor : .monochrome)
                    .frame(width: Layout.minTapTarget, height: Layout.minTapTarget)
            }
            .accessibilityLabel(appState.unreadNotificationCount > 0
                ? "\(appState.unreadNotificationCount) unread notifications"
                : "Notifications")
        }
    }
}

// MARK: - Menu Section

private struct MenuSection<Content: View>: View {
    let title: String
    let icon: String
    let color: Color
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
            HStack(spacing: WellnessSpacing.xs) {
                Image(systemName: icon)
                    .font(.caption.weight(.semibold))
                    .foregroundColor(color)
                Text(title.uppercased())
                    .font(.wellnessCaption2)
                    .fontWeight(.bold)
                    .foregroundColor(.wellnessMuted)
                    .tracking(0.8)
            }
            .padding(.leading, WellnessSpacing.xs)

            LazyVGrid(
                columns: [GridItem(.flexible()), GridItem(.flexible())],
                spacing: WellnessSpacing.sm
            ) {
                content()
            }
        }
    }
}

// MARK: - Menu Tile

private struct MenuTile: View {
    let icon: String
    let title: String
    let subtitle: String
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: WellnessSpacing.sm) {
                ZStack {
                    RoundedRectangle(cornerRadius: WellnessRadius.small)
                        .fill(color.opacity(0.12))
                        .frame(width: 38, height: 38)
                    Image(systemName: icon)
                        .font(.system(size: IconSize.badge, weight: .medium))
                        .foregroundColor(color)
                }
                VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                    MarqueeText(
                        text: title,
                        font: .wellnessSubheadline,
                        foregroundColor: .wellnessOnSurface
                    )
                    MarqueeText(
                        text: subtitle,
                        font: .wellnessCaption2,
                        foregroundColor: .wellnessMuted
                    )
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, WellnessSpacing.sm)
            .padding(.vertical, WellnessSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.wellnessSurface)
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }
}

// MARK: - Error Banner

struct ErrorBanner: View {
    let message: String

    var body: some View {
        HStack(spacing: WellnessSpacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: IconSize.badge))
                .foregroundColor(.wellnessError)
            Text(message)
                .font(.wellnessCaption)
                .foregroundColor(.wellnessError)
                .lineLimit(2)
        }
        .padding(.horizontal, Layout.cardPadding)
        .padding(.vertical, WellnessSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.wellnessError.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
    }
}

// MARK: - Quick Action Tile (kept for other potential uses)

struct QuickActionTile: View {
    let icon: String
    let title: String
    let action: () -> Void

    @EnvironmentObject var appState: AppState

    var body: some View {
        InteractiveCard(action: action) {
            VStack(spacing: WellnessSpacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: IconSize.medium))
                    .foregroundColor(appState.brandColor)
                Text(title)
                    .font(.wellnessCaption)
                    .fontWeight(.medium)
                    .foregroundColor(.wellnessOnSurface)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Layout.cardPaddingLarge)
            .padding(.horizontal, WellnessSpacing.sm)
        }
        .accessibilityLabel(title)
    }
}

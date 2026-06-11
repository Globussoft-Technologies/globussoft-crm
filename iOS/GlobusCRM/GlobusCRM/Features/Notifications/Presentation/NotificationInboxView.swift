import SwiftUI

struct NotificationInboxView: View {
    @StateObject var viewModel: NotificationInboxViewModel
    @EnvironmentObject var router: AppRouter
    @State private var selectedNotification: AppNotification?

    var body: some View {
        Group {
            if viewModel.notifications.isEmpty {
                EmptyStateView(
                    icon: "bell.slash",
                    title: "No Notifications",
                    subtitle: "You're all caught up! New notifications will appear here."
                )
            } else {
                List {
                    ForEach(viewModel.notifications) { notification in
                        NotificationRowView(notification: notification)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                if !notification.isRead { viewModel.markRead(notification) }
                                selectedNotification = notification
                            }
                            .listRowBackground(notification.isRead ? Color.clear : Color.wellnessTeal.opacity(0.05))
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: .destructive) {
                                    viewModel.delete(notification)
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                if !notification.isRead {
                                    Button {
                                        viewModel.markRead(notification)
                                    } label: {
                                        Label("Mark Read", systemImage: "envelope.open")
                                    }
                                    .tint(.wellnessTeal)
                                }
                            }
                    }
                }
                .listStyle(.plain)
                .refreshable { viewModel.load() }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            if viewModel.unreadCount > 0 {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Mark All Read") {
                        viewModel.markAllRead()
                    }
                    .font(.wellnessCaption)
                }
            }
        }
        .task { viewModel.load() }
        .sheet(item: $selectedNotification) { notification in
            NotificationDetailSheet(notification: notification) {
                handleNavigation(notification)
            }
        }
    }

    private func handleNavigation(_ notification: AppNotification) {
        selectedNotification = nil
        guard let screen = notification.screen else { return }
        switch screen {
        case "appointments":    router.navigate(to: .myAppointments)
        case "prescriptions":   router.navigate(to: .prescriptions)
        case "treatmentPlans":  router.navigate(to: .treatmentPlans)
        case "consentForms":    router.navigate(to: .consentForms)
        case "wallet":          router.navigate(to: .wallet)
        case "giftCards":       router.navigate(to: .giftCards)
        case "memberships":     router.navigate(to: .memberships)
        case "loyalty":         router.navigate(to: .loyalty)
        case "finance":         router.navigate(to: .finance)
        case "catalog":         router.navigate(to: .catalog)
        case "book":            router.navigate(to: .bookAppointment())
        default: break
        }
    }
}

// MARK: - Detail Sheet

private struct NotificationDetailSheet: View {
    let notification: AppNotification
    let onNavigate: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: WellnessSpacing.lg) {
                    ZStack {
                        Circle()
                            .fill(notificationColor.opacity(0.12))
                            .frame(width: 64, height: 64)
                        Image(systemName: notification.iconName)
                            .font(.system(size: IconSize.medium))
                            .foregroundColor(notificationColor)
                    }
                    .padding(.top, WellnessSpacing.lg)

                    VStack(spacing: WellnessSpacing.sm) {
                        Text(notification.title)
                            .font(.wellnessTitle3)
                            .foregroundColor(.wellnessOnSurface)
                            .multilineTextAlignment(.center)

                        Text(notification.body)
                            .font(.wellnessBody)
                            .foregroundColor(.wellnessMuted)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, Layout.pagePadding)

                    Text(notification.formattedTime)
                        .font(.wellnessCaption2)
                        .foregroundColor(.wellnessMuted)

                    if notification.screen != nil {
                        WellnessButton("Go to \(screenLabel(notification.screen))") {
                            onNavigate()
                        }
                        .padding(.horizontal, Layout.pagePadding)
                    }
                }
                .padding(.bottom, WellnessSpacing.xl)
            }
            .background(Color.wellnessBackground.ignoresSafeArea())
            .navigationTitle("Notification")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private var notificationColor: Color {
        switch notification.type {
        case .appointment:  return .wellnessTeal
        case .prescription: return .wellnessBlush
        case .billing:      return .wellnessGold
        case .loyalty:      return .wellnessGold
        case .membership:   return .wellnessTeal
        case .promotion:    return .wellnessBlush
        case .general:      return .wellnessMuted
        }
    }

    private func screenLabel(_ screen: String?) -> String {
        switch screen {
        case "appointments":    return "Appointments"
        case "prescriptions":   return "Prescriptions"
        case "treatmentPlans":  return "Treatment Plans"
        case "consentForms":    return "Consent Forms"
        case "wallet":          return "Wallet"
        case "giftCards":       return "Gift Cards"
        case "memberships":     return "Memberships"
        case "loyalty":         return "Loyalty"
        case "finance":         return "Finance"
        case "catalog":         return "Catalog"
        case "book":            return "Book Appointment"
        default:                return "Details"
        }
    }
}

// MARK: - Row

struct NotificationRowView: View {
    let notification: AppNotification

    var body: some View {
        HStack(alignment: .top, spacing: WellnessSpacing.md) {
            ZStack {
                Circle()
                    .fill(notificationColor.opacity(0.15))
                    .frame(width: 44, height: 44)
                Image(systemName: notification.iconName)
                    .foregroundColor(notificationColor)
                    .font(.system(size: IconSize.small))
                    .accessibilityHidden(true)
            }

            VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                HStack {
                    MarqueeText(
                        text: notification.title,
                        font: notification.isRead ? .wellnessBody : .wellnessSubheadline,
                        foregroundColor: .wellnessOnSurface
                    )
                    Spacer()
                    Text(notification.formattedTime)
                        .font(.wellnessCaption2)
                        .foregroundColor(.wellnessMuted)
                }
                Text(notification.body)
                    .font(.wellnessCaption)
                    .foregroundColor(.wellnessMuted)
                    .lineLimit(2)
            }

            if !notification.isRead {
                Circle()
                    .fill(Color.wellnessTeal)
                    .frame(width: 8, height: 8)
                    .padding(.top, WellnessSpacing.xs)
                    .accessibilityLabel("Unread")
            }
        }
        .padding(.vertical, WellnessSpacing.sm)
        .accessibilityElement(children: .combine)
    }

    private var notificationColor: Color {
        switch notification.type {
        case .appointment:  return .wellnessTeal
        case .prescription: return .wellnessBlush
        case .billing:      return .wellnessGold
        case .loyalty:      return .wellnessGold
        case .membership:   return .wellnessTeal
        case .promotion:    return .wellnessBlush
        case .general:      return .wellnessMuted
        }
    }
}

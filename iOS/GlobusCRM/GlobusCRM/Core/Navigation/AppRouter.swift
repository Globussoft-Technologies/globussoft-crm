import SwiftUI
import Combine

@MainActor
final class AppRouter: ObservableObject {
    // Per-tab independent typed back stacks (inspectable for dedup)
    @Published var homePath:     [AppRoute] = []
    @Published var bookingsPath: [AppRoute] = []
    @Published var catalogPath:  [AppRoute] = []
    @Published var financePath:  [AppRoute] = []
    @Published var profilePath:  [AppRoute] = []

    @Published var presentedSheet: AppSheet?
    @Published var selectedTab: TabRoute = .home

    // Auth flow (login → register)
    @Published var authPath: [AppRoute] = []

    // MARK: - Navigation

    func navigate(to route: AppRoute) {
        switch route {
        // Bookings-tab routes
        case .visitHistory, .waitlist:
            selectedTab = .bookings
            push(route, to: &bookingsPath)

        // Profile-tab routes
        case .notificationSettings:
            selectedTab = .profile
            push(route, to: &profilePath)

        // Notification inbox — push on the active tab or fall back to home
        case .notificationInbox:
            switch selectedTab {
            case .profile:  push(route, to: &profilePath)
            case .bookings: push(route, to: &bookingsPath)
            default:        push(route, to: &homePath)
            }

        // Finance-tab routes
        case .wallet, .giftCards:
            selectedTab = .finance
            push(route, to: &financePath)

        case .finance:
            selectedTab = .finance

        // Catalog tab — just switch, no push
        case .catalog:
            selectedTab = .catalog

        // Booking wizard — push on the active tab
        case .bookAppointment:
            switch selectedTab {
            case .bookings: push(route, to: &bookingsPath)
            case .catalog:  push(route, to: &catalogPath)
            default:        push(route, to: &homePath)
            }

        // Home-tab routes (prescriptions, treatmentPlans, consentForms, memberships, loyalty…)
        default:
            push(route, to: &homePath)
        }
    }

    // MARK: - Back navigation

    func pop() {
        switch selectedTab {
        case .home:     homePath.removeLast(homePath.isEmpty ? 0 : 1)
        case .bookings: bookingsPath.removeLast(bookingsPath.isEmpty ? 0 : 1)
        case .catalog:  catalogPath.removeLast(catalogPath.isEmpty ? 0 : 1)
        case .finance:  financePath.removeLast(financePath.isEmpty ? 0 : 1)
        case .profile:  profilePath.removeLast(profilePath.isEmpty ? 0 : 1)
        }
    }

    func popToRoot() {
        homePath     = []
        bookingsPath = []
        catalogPath  = []
        financePath  = []
        profilePath  = []
    }

    func popCurrentTabToRoot() {
        clearTabPath(for: selectedTab)
    }

    func clearTabPath(for tab: TabRoute) {
        switch tab {
        case .home:     homePath     = []
        case .bookings: bookingsPath = []
        case .catalog:  catalogPath  = []
        case .finance:  financePath  = []
        case .profile:  profilePath  = []
        }
    }

    // MARK: - Sheets

    func present(_ sheet: AppSheet) { presentedSheet = sheet }
    func dismissSheet()             { presentedSheet = nil }

    // MARK: - Private

    /// Appends route only if it isn't already the top of the stack.
    private func push(_ route: AppRoute, to path: inout [AppRoute]) {
        guard path.last != route else { return }
        path.append(route)
    }
}

// MARK: - AppSheet

enum AppSheet: Identifiable {
    case rescheduleAppointment(appointmentId: Int)
    case addWaitlist
    case visitDetail(visitId: Int)
    case serviceDetail(serviceId: Int)
    case membershipPlanDetail(planId: Int)
    case transactionReceipt(transactionId: String)
    case giftCardBuyConfirm(giftCardId: Int)
    case prescriptionDownloadConfirm(prescriptionId: Int)

    var id: String {
        switch self {
        case .rescheduleAppointment(let id):      return "reschedule-\(id)"
        case .addWaitlist:                        return "addWaitlist"
        case .visitDetail(let id):                return "visit-\(id)"
        case .serviceDetail(let id):              return "service-\(id)"
        case .membershipPlanDetail(let id):       return "plan-\(id)"
        case .transactionReceipt(let id):         return "receipt-\(id)"
        case .giftCardBuyConfirm(let id):         return "giftcard-\(id)"
        case .prescriptionDownloadConfirm(let id):return "rxdownload-\(id)"
        }
    }
}

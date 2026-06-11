import Foundation

enum AppRoute: Hashable {
    case splash
    case login
    case register
    case dashboard
    case bookAppointment(serviceId: Int? = nil, membershipId: Int? = nil)
    case myAppointments
    case visitHistory
    case waitlist
    case prescriptions
    case prescriptionPdf(prescriptionId: Int)
    case treatmentPlans
    case consentForms
    case memberships
    case wallet
    case giftCards
    case finance
    case catalog
    case loyalty
    case profile
    case notificationInbox
    case notificationSettings
}

enum TabRoute: Int, CaseIterable {
    case home = 0
    case bookings = 1
    case catalog = 2
    case finance = 3
    case profile = 4

    var title: String {
        switch self {
        case .home:     return "Home"
        case .bookings: return "Bookings"
        case .catalog:  return "Catalog"
        case .finance:  return "Finance"
        case .profile:  return "Profile"
        }
    }

    var icon: String {
        switch self {
        case .home:     return "house"
        case .bookings: return "calendar"
        case .catalog:  return "list.bullet"
        case .finance:  return "creditcard"
        case .profile:  return "person"
        }
    }
}

import Foundation

struct DashboardUiState {
    var isLoading: Bool = false
    var error: String? = nil
    var patientName: String = ""
    var walletBalance: Double? = nil
    var membershipStatus: String? = nil
    var loyaltyPoints: Int? = nil
    var nextAppointment: AppointmentPreview? = nil
    var currency: String = "INR"
    var searchQuery: String = ""
}

enum DashboardUiEvent {
    case refresh
    case searchChanged(String)
    case navigate(AppRoute)
}

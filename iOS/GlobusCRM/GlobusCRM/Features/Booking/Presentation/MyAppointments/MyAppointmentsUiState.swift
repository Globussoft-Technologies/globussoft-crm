import Foundation

struct MyAppointmentsUiState {
    var isLoading: Bool = false
    var error: String? = nil
    var selectedBucket: AppointmentBucket = .upcoming
    var appointments: [String: [Appointment]] = [:]
    var selectedAppointment: Appointment? = nil
    var activeSheet: AppointmentActiveSheet? = nil
    var rescheduleDate: Date = Date()
    var rescheduleTime: String = "09:00"
}

enum AppointmentActiveSheet: Identifiable {
    case actions, detail, reschedule, cancel
    var id: Self { self }
}

enum AppointmentBucket: String, CaseIterable {
    case upcoming, pending, past, cancelled
    var displayName: String {
        switch self {
        case .past: return "Past"
        default: return rawValue.capitalized
        }
    }
}

enum MyAppointmentsUiEvent {
    case selectBucket(AppointmentBucket)
    case tapAppointment(Appointment)
    case dismissActionSheet
    case viewDetails
    case reschedule(id: Int, date: String, time: String)
    case cancelAppointment(id: Int)
    case refresh
}

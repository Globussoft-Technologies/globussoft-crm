import Foundation

struct Appointment: Identifiable {
    let id: Int
    let doctorName: String?
    let serviceName: String?
    let appointmentDate: String
    let status: AppointmentStatus
    let reason: String?
    let doctorAssigned: Bool
    let bookingType: String?
    let videoCallUrl: String?
    let canCancel: Bool
    let canReschedule: Bool
}

enum AppointmentStatus: String {
    case upcoming, pending, cancelled, completed, booked
    var displayName: String { rawValue.capitalized }
}

struct BookAppointmentRequest {
    let appointmentDate: String    // "YYYY-MM-DD" — NOT ISO8601 with time
    let appointmentTime: String    // "HH:mm"
    let reason: String
    let doctorId: Int?
    let serviceId: Int?
    let membershipId: Int?
}

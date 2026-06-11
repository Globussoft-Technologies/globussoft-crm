import Foundation

struct DashboardSummary {
    let patientName: String
    let walletBalance: Double?
    let membershipStatus: String?
    let loyaltyPoints: Int?
    let nextAppointment: AppointmentPreview?
    let currency: String
}

struct AppointmentPreview {
    let id: Int
    let doctorName: String?
    let serviceName: String?
    let appointmentDate: String
    let status: String
}

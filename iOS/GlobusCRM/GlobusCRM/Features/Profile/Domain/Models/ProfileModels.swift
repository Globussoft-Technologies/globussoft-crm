import Foundation

struct PatientProfile: Equatable {
    let id: String
    var name: String
    var email: String
    var phone: String
    var dateOfBirth: String?
    var gender: String?
    var address: String?
    var avatarUrl: String?
    var bloodGroup: String?
    var emergencyContact: String?
}

struct NotificationPreference: Equatable {
    var appointmentReminders: Bool
    var promotions: Bool
    var healthTips: Bool
    var billing: Bool
    var generalUpdates: Bool

    // Delivery channels
    var pushNotifications: Bool
    var smsNotifications: Bool
    var emailNotifications: Bool

    // Quiet hours
    var quietHoursEnabled: Bool
    var quietHoursStartMinutes: Int  // minutes from midnight (e.g. 1320 = 22:00)
    var quietHoursEndMinutes: Int    // e.g. 480 = 08:00
}

import Foundation

extension PatientProfileDTO {
    func toDomain() -> PatientProfile {
        PatientProfile(
            id: String(id),
            name: name ?? "",
            email: email ?? "",
            phone: phone ?? "",
            dateOfBirth: dob,
            gender: gender,
            address: address,
            avatarUrl: avatarUrl,
            bloodGroup: bloodGroup,
            emergencyContact: emergencyContact
        )
    }
}


extension NotificationPreferenceDTO {
    func toDomain() -> NotificationPreference {
        NotificationPreference(
            appointmentReminders: appointmentReminders ?? true,
            promotions: promotions ?? false,
            healthTips: healthTips ?? true,
            billing: billing ?? true,
            generalUpdates: generalUpdates ?? true,
            pushNotifications: true,
            smsNotifications: false,
            emailNotifications: true,
            quietHoursEnabled: false,
            quietHoursStartMinutes: 1320,
            quietHoursEndMinutes: 480
        )
    }
}

// Only name and email are editable via PUT /api/auth/me
extension PatientProfile {
    func toUpdateDTO() -> UpdateProfileRequestDTO {
        UpdateProfileRequestDTO(name: name, email: email)
    }
}

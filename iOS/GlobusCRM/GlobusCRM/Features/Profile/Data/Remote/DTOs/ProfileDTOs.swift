import Foundation

// GET /wellness/portal/me — patient-layer: phone, dob, gender (read-only display fields)
// Field names confirmed from backend: dob (not dateOfBirth), id is Int
struct PatientProfileDTO: Codable {
    let id: Int
    let name: String?
    let email: String?
    let phone: String?
    let dob: String?
    let gender: String?
    let address: String?
    let avatarUrl: String?
    let bloodGroup: String?
    let emergencyContact: String?
}

// PUT /api/auth/me — only name and email are accepted (absolute path)
// AuthProfileResponseDTO is defined in AuthDTOs.swift (shared with login/register flow)
struct UpdateProfileRequestDTO: Codable {
    let name: String
    let email: String
}

// POST /auth/me/profile-picture — returns { id, name, email, role, profilePicture }
struct AvatarUploadResponseDTO: Codable {
    let profilePicture: String?
}

struct ChangePasswordRequestDTO: Codable {
    let currentPassword: String
    let newPassword: String
}

// GET /wellness/portal/me/notification-preferences — endpoint not yet implemented in backend
struct NotificationPreferenceResponseDTO: Codable {
    let data: NotificationPreferenceDTO?
}

struct NotificationPreferenceDTO: Codable {
    let appointmentReminders: Bool?
    let promotions: Bool?
    let healthTips: Bool?
    let billing: Bool?
    let generalUpdates: Bool?
}

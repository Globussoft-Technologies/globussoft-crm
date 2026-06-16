import Foundation

final class ProfileRepositoryImpl: ProfileRepository {
    private let apiClient: WellnessAPIClient
    private let keychain: KeychainManager

    init(apiClient: WellnessAPIClient, keychain: KeychainManager) {
        self.apiClient = apiClient
        self.keychain = keychain
    }

    // GET /wellness/portal/me — patient layer: phone, dob, gender (read-only)
    func getProfile(patientId: String) async -> Result<PatientProfile, AppError> {
        let result: Result<PatientProfileDTO, AppError> = await apiClient.request(
            endpoint: .getPatientProfile(patientId: patientId)
        )
        switch result {
        case .success(let dto): return .success(dto.toDomain())
        case .failure(let e): return .failure(e)
        }
    }

    // GET /api/auth/me — user layer: name, email, profilePicture (editable)
    func getAuthProfile() async -> Result<PatientProfile, AppError> {
        let result: Result<AuthProfileResponseDTO, AppError> = await apiClient.request(
            endpoint: .authMe
        )
        switch result {
        case .success(let dto):
            let profile = PatientProfile(
                id: String(dto.id), name: dto.name, email: dto.email,
                phone: "", dateOfBirth: nil, gender: nil, address: nil,
                avatarUrl: dto.profilePicture, bloodGroup: nil, emergencyContact: nil
            )
            return .success(profile)
        case .failure(let e): return .failure(e)
        }
    }

    // PUT /api/auth/me — only name and email accepted; portal/me has no PUT endpoint
    func updateProfile(_ profile: PatientProfile) async -> Result<PatientProfile, AppError> {
        let dto = profile.toUpdateDTO()
        let result: Result<AuthProfileResponseDTO, AppError> = await apiClient.requestWithBody(
            endpoint: .updateAuthMe,
            body: dto
        )
        switch result {
        case .success(let r):
            keychain.setName(r.name)
            let updated = PatientProfile(
                id: String(r.id), name: r.name, email: r.email,
                phone: "", dateOfBirth: nil, gender: nil, address: nil,
                avatarUrl: r.profilePicture, bloodGroup: nil, emergencyContact: nil
            )
            return .success(updated)
        case .failure(let e): return .failure(e)
        }
    }

    // POST /auth/me/profile-picture — returns { id, name, email, role, profilePicture }
    func updateAvatar(imageData: Data) async -> Result<String, AppError> {
        let result = await apiClient.uploadMultipart(
            endpoint: .uploadAvatar,
            data: imageData,
            fieldName: "file",
            fileName: "avatar.jpg",
            mimeType: "image/jpeg"
        )
        switch result {
        case .success(let data):
            if let dto = try? JSONDecoder().decode(AvatarUploadResponseDTO.self, from: data),
               let url = dto.profilePicture {
                return .success(url)
            }
            return .failure(.decoding("Failed to parse avatar URL"))
        case .failure(let e): return .failure(e)
        }
    }

    // DELETE /api/auth/me/profile-picture
    func removeAvatar() async -> Result<Void, AppError> {
        return await apiClient.resultVoid(.deleteProfilePicture)
    }

    func changePassword(current: String, new: String) async -> Result<Void, AppError> {
        let body = ChangePasswordRequestDTO(currentPassword: current, newPassword: new)
        return await apiClient.requestVoid(endpoint: .changePassword, body: body)
    }

    func getNotificationPreferences(patientId: String) async -> Result<NotificationPreference, AppError> {
        let result: Result<NotificationPreferenceResponseDTO, AppError> = await apiClient.request(
            endpoint: .getNotificationPreferences(patientId: patientId)
        )
        switch result {
        case .success(let r):
            return .success(r.data?.toDomain() ?? NotificationPreference(
                appointmentReminders: true, promotions: false,
                healthTips: true, billing: true, generalUpdates: true,
                pushNotifications: true, smsNotifications: false, emailNotifications: true,
                quietHoursEnabled: false, quietHoursStartMinutes: 1320, quietHoursEndMinutes: 480
            ))
        case .failure(let e): return .failure(e)
        }
    }

    func updateNotificationPreferences(_ prefs: NotificationPreference, patientId: String) async -> Result<Void, AppError> {
        let body = NotificationPreferenceDTO(
            appointmentReminders: prefs.appointmentReminders,
            promotions: prefs.promotions,
            healthTips: prefs.healthTips,
            billing: prefs.billing,
            generalUpdates: prefs.generalUpdates
        )
        return await apiClient.requestVoid(endpoint: .updateNotificationPreferences(patientId: patientId), body: body)
    }

    func requestDataExport(patientId: String) async -> Result<Void, AppError> {
        return await apiClient.requestVoid(endpoint: .requestDataExport(patientId: patientId), body: EmptyBody())
    }

    func deleteAccount(password: String?, code: String?) async -> Result<Void, AppError> {
        let body = DeleteAccountRequestDTO(confirmDestructive: true, password: password, code: code)
        return await apiClient.requestVoid(endpoint: .requestAccountDeletion, body: body)
    }
}

private struct EmptyBody: Encodable {}

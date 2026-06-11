import Foundation

protocol ProfileRepository {
    func getProfile(patientId: String) async -> Result<PatientProfile, AppError>
    func getAuthProfile() async -> Result<PatientProfile, AppError>
    func updateProfile(_ profile: PatientProfile) async -> Result<PatientProfile, AppError>
    func updateAvatar(imageData: Data) async -> Result<String, AppError>
    func removeAvatar() async -> Result<Void, AppError>
    func changePassword(current: String, new: String) async -> Result<Void, AppError>
    func getNotificationPreferences(patientId: String) async -> Result<NotificationPreference, AppError>
    func updateNotificationPreferences(_ prefs: NotificationPreference, patientId: String) async -> Result<Void, AppError>
    func requestDataExport(patientId: String) async -> Result<Void, AppError>
    func requestAccountDeletion(patientId: String) async -> Result<Void, AppError>
}

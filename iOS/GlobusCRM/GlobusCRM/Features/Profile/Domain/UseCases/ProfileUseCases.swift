import Foundation

final class GetProfileUseCase {
    private let repository: ProfileRepository
    init(repository: ProfileRepository) { self.repository = repository }
    func callAsFunction(patientId: String) async -> Result<PatientProfile, AppError> {
        await repository.getProfile(patientId: patientId)
    }
}

final class GetAuthProfileUseCase {
    private let repository: ProfileRepository
    init(repository: ProfileRepository) { self.repository = repository }
    func callAsFunction() async -> Result<PatientProfile, AppError> {
        await repository.getAuthProfile()
    }
}

final class UpdateProfileUseCase {
    private let repository: ProfileRepository
    init(repository: ProfileRepository) { self.repository = repository }
    func callAsFunction(_ profile: PatientProfile) async -> Result<PatientProfile, AppError> {
        await repository.updateProfile(profile)
    }
}

final class UpdateAvatarUseCase {
    private let repository: ProfileRepository
    init(repository: ProfileRepository) { self.repository = repository }
    func callAsFunction(imageData: Data) async -> Result<String, AppError> {
        await repository.updateAvatar(imageData: imageData)
    }
}

final class RemoveAvatarUseCase {
    private let repository: ProfileRepository
    init(repository: ProfileRepository) { self.repository = repository }
    func callAsFunction() async -> Result<Void, AppError> {
        await repository.removeAvatar()
    }
}

final class ChangePasswordUseCase {
    private let repository: ProfileRepository
    init(repository: ProfileRepository) { self.repository = repository }
    func callAsFunction(current: String, new: String) async -> Result<Void, AppError> {
        await repository.changePassword(current: current, new: new)
    }
}

final class GetNotificationPreferencesUseCase {
    private let repository: ProfileRepository
    init(repository: ProfileRepository) { self.repository = repository }
    func callAsFunction(patientId: String) async -> Result<NotificationPreference, AppError> {
        await repository.getNotificationPreferences(patientId: patientId)
    }
}

final class UpdateNotificationPreferencesUseCase {
    private let repository: ProfileRepository
    init(repository: ProfileRepository) { self.repository = repository }
    func callAsFunction(_ prefs: NotificationPreference, patientId: String) async -> Result<Void, AppError> {
        await repository.updateNotificationPreferences(prefs, patientId: patientId)
    }
}

final class RequestDataExportUseCase {
    private let repository: ProfileRepository
    init(repository: ProfileRepository) { self.repository = repository }
    func callAsFunction(patientId: String) async -> Result<Void, AppError> {
        await repository.requestDataExport(patientId: patientId)
    }
}

final class RequestAccountDeletionUseCase {
    private let repository: ProfileRepository
    init(repository: ProfileRepository) { self.repository = repository }
    func callAsFunction(password: String?, code: String?) async -> Result<Void, AppError> {
        await repository.deleteAccount(password: password, code: code)
    }
}

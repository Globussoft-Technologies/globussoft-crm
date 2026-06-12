import Foundation
import Combine
import PhotosUI
import SwiftUI

@MainActor
final class ProfileViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var profile: PatientProfile? = nil
    @Published var editedProfile: PatientProfile? = nil
    @Published var isEditing = false
    @Published var isSaving = false
    @Published var error: String? = nil
    @Published var successMessage: String? = nil
    @Published var showChangePassword = false
    @Published var showDSAR = false
    @Published var selectedPhotoItem: PhotosPickerItem? = nil
    @Published var avatarImage: Image? = nil

    private let getProfileUseCase: GetProfileUseCase
    private let getAuthProfileUseCase: GetAuthProfileUseCase
    private let updateProfileUseCase: UpdateProfileUseCase
    private let updateAvatarUseCase: UpdateAvatarUseCase
    private let removeAvatarUseCase: RemoveAvatarUseCase
    private let changePasswordUseCase: ChangePasswordUseCase
    private let requestDataExportUseCase: RequestDataExportUseCase
    private let requestAccountDeletionUseCase: RequestAccountDeletionUseCase
    private let logoutUseCase: LogoutUseCase
    private let notificationDAO: NotificationDAO
    private let appState: AppState
    private let router: AppRouter
    private let sessionManager: SessionManager
    private let keychain: KeychainManager
    private var cancellables = Set<AnyCancellable>()

    init(getProfileUseCase: GetProfileUseCase,
         getAuthProfileUseCase: GetAuthProfileUseCase,
         updateProfileUseCase: UpdateProfileUseCase,
         updateAvatarUseCase: UpdateAvatarUseCase,
         removeAvatarUseCase: RemoveAvatarUseCase,
         changePasswordUseCase: ChangePasswordUseCase,
         requestDataExportUseCase: RequestDataExportUseCase,
         requestAccountDeletionUseCase: RequestAccountDeletionUseCase,
         logoutUseCase: LogoutUseCase,
         notificationDAO: NotificationDAO,
         appState: AppState,
         router: AppRouter,
         sessionManager: SessionManager,
         keychain: KeychainManager) {
        self.getProfileUseCase = getProfileUseCase
        self.getAuthProfileUseCase = getAuthProfileUseCase
        self.updateProfileUseCase = updateProfileUseCase
        self.updateAvatarUseCase = updateAvatarUseCase
        self.removeAvatarUseCase = removeAvatarUseCase
        self.changePasswordUseCase = changePasswordUseCase
        self.requestDataExportUseCase = requestDataExportUseCase
        self.requestAccountDeletionUseCase = requestAccountDeletionUseCase
        self.logoutUseCase = logoutUseCase
        self.notificationDAO = notificationDAO
        self.appState = appState
        self.router = router
        self.sessionManager = sessionManager
        self.keychain = keychain

        $selectedPhotoItem
            .compactMap { $0 }
            .sink { [weak self] item in
                Task { await self?.handlePhotoSelection(item) }
            }
            .store(in: &cancellables)
    }

    func load() async {
        guard let patientId = keychain.getPatientIdString() else {
            error = "Session error — please log out and log in again."
            return
        }
        isLoading = true
        error = nil
        // Load patient layer (phone, dob, gender — read-only) and user layer (name, email, avatar) in parallel
        async let patientResult = getProfileUseCase(patientId: patientId)
        async let authResult = getAuthProfileUseCase()
        let (patientRes, authRes) = await (patientResult, authResult)
        isLoading = false
        if case .success(let patient) = patientRes, case .success(let auth) = authRes {
            // Merge: auth/me provides authoritative name/email/avatar; portal/me provides read-only demographics
            let merged = PatientProfile(
                id: patient.id,
                name: auth.name.isEmpty ? patient.name : auth.name,
                email: auth.email.isEmpty ? patient.email : auth.email,
                phone: patient.phone,
                dateOfBirth: patient.dateOfBirth,
                gender: patient.gender,
                address: patient.address,
                avatarUrl: auth.avatarUrl ?? patient.avatarUrl,
                bloodGroup: patient.bloodGroup,
                emergencyContact: patient.emergencyContact
            )
            profile = merged
            editedProfile = merged
        } else if case .success(let patient) = patientRes {
            profile = patient
            editedProfile = patient
        } else if case .failure(let e) = patientRes {
            error = e.localizedDescription
        }
    }

    func startEditing() {
        editedProfile = profile
        isEditing = true
    }

    func cancelEditing() {
        editedProfile = profile
        isEditing = false
    }

    func saveProfile() async {
        guard let edited = editedProfile, let current = profile else { return }
        isSaving = true
        error = nil
        let result = await updateProfileUseCase(edited)
        isSaving = false
        switch result {
        case .success(let updated):
            // auth/me response only returns user-layer fields; preserve read-only patient-layer fields
            let merged = PatientProfile(
                id: current.id,
                name: updated.name,
                email: updated.email,
                phone: current.phone,
                dateOfBirth: current.dateOfBirth,
                gender: current.gender,
                address: current.address,
                avatarUrl: updated.avatarUrl ?? current.avatarUrl,
                bloodGroup: current.bloodGroup,
                emergencyContact: current.emergencyContact
            )
            profile = merged
            editedProfile = merged
            isEditing = false
            successMessage = "Profile updated successfully."
        case .failure(let e):
            error = e.localizedDescription
        }
    }

    func changePassword(current: String, new: String, confirm: String) async {
        guard new == confirm else {
            error = "New passwords don't match."
            return
        }
        guard new.count >= 8 else {
            error = "Password must be at least 8 characters."
            return
        }
        isSaving = true
        error = nil
        let result = await changePasswordUseCase(current: current, new: new)
        isSaving = false
        switch result {
        case .success:
            successMessage = "Password changed successfully."
            showChangePassword = false
        case .failure(let e):
            error = e.localizedDescription
        }
    }

    func requestDataExport() async {
        guard let patientId = keychain.getPatientIdString() else { return }
        let result = await requestDataExportUseCase(patientId: patientId)
        if case .success = result {
            successMessage = "Data export request submitted. You'll receive an email within 72 hours."
        } else if case .failure(let e) = result {
            error = e.localizedDescription
        }
    }

    func deleteAccount(password: String, code: String?) async {
        isSaving = true
        error = nil
        let result = await requestAccountDeletionUseCase(password: password, code: code)
        isSaving = false
        guard case .success = result else {
            if case .failure(let e) = result { error = e.localizedDescription }
            return
        }
        // Account deleted server-side — clear local state identically to logout
        await logoutUseCase()
        notificationDAO.deleteAll()
        profile = nil
        editedProfile = nil
        avatarImage = nil
        selectedPhotoItem = nil
        isEditing = false
        appState.clearPermissions()
        appState.unreadNotificationCount = 0
        router.popToRoot()
        router.authPath = []
        sessionManager.setUnauthenticated()
    }

    func logout() async {
        isSaving = true
        await logoutUseCase()
        notificationDAO.deleteAll()

        profile = nil
        editedProfile = nil
        avatarImage = nil
        selectedPhotoItem = nil
        isEditing = false
        appState.clearPermissions()
        appState.unreadNotificationCount = 0
        router.popToRoot()
        router.authPath = []
        sessionManager.setUnauthenticated()
        isSaving = false
    }

    func removeAvatar() async {
        let result = await removeAvatarUseCase()
        if case .success = result {
            avatarImage = nil
            profile?.avatarUrl = nil
            editedProfile?.avatarUrl = nil
            successMessage = "Profile picture removed."
        } else if case .failure(let e) = result {
            error = e.localizedDescription
        }
    }

    private func handlePhotoSelection(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        if let uiImage = UIImage(data: data) {
            avatarImage = Image(uiImage: uiImage)
        }
        let result = await updateAvatarUseCase(imageData: data)
        if case .success(let url) = result {
            profile?.avatarUrl = url
            editedProfile?.avatarUrl = url
            successMessage = "Avatar updated."
        } else if case .failure(let e) = result {
            error = e.localizedDescription
        }
    }

    static var placeholder: ProfileViewModel {
        fatalError("Inject via AppContainer")
    }
}

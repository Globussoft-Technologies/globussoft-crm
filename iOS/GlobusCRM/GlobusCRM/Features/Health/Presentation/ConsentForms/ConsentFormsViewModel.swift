import Foundation
import Combine

@MainActor
final class ConsentFormsViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var hasLoaded = false
    @Published var forms: [ConsentForm] = []
    @Published var error: String? = nil

    private let getConsentFormsUseCase: GetConsentFormsUseCase
    private let keychain: KeychainManager

    init(getConsentFormsUseCase: GetConsentFormsUseCase, keychain: KeychainManager) {
        self.getConsentFormsUseCase = getConsentFormsUseCase
        self.keychain = keychain
    }

    func load() async {
        guard let patientId = keychain.getPatientIdString() else {
            hasLoaded = true
            error = "Session error — please log out and log in again."
            return
        }
        isLoading = true
        error = nil
        let result = await getConsentFormsUseCase(patientId: patientId)
        isLoading = false
        hasLoaded = true
        switch result {
        case .success(let items): forms = items
        case .failure(let err): error = err.localizedDescription
        }
    }
}

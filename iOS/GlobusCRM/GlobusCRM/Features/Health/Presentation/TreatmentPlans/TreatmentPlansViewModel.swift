import Foundation
import Combine

@MainActor
final class TreatmentPlansViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var hasLoaded = false
    @Published var plans: [TreatmentPlan] = []
    @Published var error: String? = nil

    private let getTreatmentPlansUseCase: GetTreatmentPlansUseCase
    private let keychain: KeychainManager

    init(getTreatmentPlansUseCase: GetTreatmentPlansUseCase, keychain: KeychainManager) {
        self.getTreatmentPlansUseCase = getTreatmentPlansUseCase
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
        let result = await getTreatmentPlansUseCase(patientId: patientId)
        isLoading = false
        hasLoaded = true
        switch result {
        case .success(let items): plans = items
        case .failure(let err): error = err.localizedDescription
        }
    }
}

import Foundation
import Combine

@MainActor
final class PrescriptionsViewModel: ObservableObject {
    @Published var uiState = PrescriptionsUiState()

    let navSignal = PassthroughSubject<PrescriptionsNavSignal, Never>()

    private let getPrescriptionsUseCase: GetPrescriptionsUseCase
    private let getPrescriptionPdfUseCase: GetPrescriptionPdfUseCase
    private let keychain: KeychainManager
    private let appState: AppState

    init(getPrescriptionsUseCase: GetPrescriptionsUseCase,
         getPrescriptionPdfUseCase: GetPrescriptionPdfUseCase,
         keychain: KeychainManager,
         appState: AppState) {
        self.getPrescriptionsUseCase = getPrescriptionsUseCase
        self.getPrescriptionPdfUseCase = getPrescriptionPdfUseCase
        self.keychain = keychain
        self.appState = appState
    }

    func onEvent(_ event: PrescriptionsUiEvent) {
        switch event {
        case .load:
            Task { await load() }
        case .selectPrescription(let p):
            uiState.selectedPrescription = p
        case .requestViewPdf(let p):
            uiState.pendingPdfPrescription = p
            uiState.showPdfConfirm = true
        case .confirmViewPdf:
            uiState.showPdfConfirm = false
            if let p = uiState.pendingPdfPrescription {
                Task { await loadPdf(prescription: p) }
            }
        case .dismissPdfConfirm:
            uiState.showPdfConfirm = false
            uiState.pendingPdfPrescription = nil
        case .viewPdf(let p):
            Task { await loadPdf(prescription: p) }
        case .dismissPdf:
            uiState.selectedPrescription = nil
        }
    }

    private func load() async {
        guard appState.hasPermission("my_prescriptions.read") else {
            uiState.hasLoaded = true
            uiState.error = "You don't have permission to view prescriptions."
            return
        }
        guard let patientId = keychain.getPatientIdString() else {
            uiState.hasLoaded = true
            uiState.error = "Session expired. Please log in again."
            return
        }
        uiState.isLoading = true
        uiState.error = nil
        let result = await getPrescriptionsUseCase(patientId: patientId)
        uiState.isLoading = false
        uiState.hasLoaded = true
        switch result {
        case .success(let items):
            uiState.prescriptions = items
        case .failure(let error):
            uiState.error = error.localizedDescription
        }
    }

    private func loadPdf(prescription: Prescription) async {
        uiState.isLoadingPdf = true
        uiState.loadingPdfId = prescription.id
        let result = await getPrescriptionPdfUseCase(prescriptionId: prescription.id)
        uiState.isLoadingPdf = false
        uiState.loadingPdfId = nil
        switch result {
        case .success(let data):
            navSignal.send(.showPdf(data))
        case .failure(let error):
            uiState.error = error.localizedDescription
        }
    }
}

import Foundation
import Combine

@MainActor
final class DashboardViewModel: ObservableObject {
    @Published private(set) var uiState = DashboardUiState()

    private let getDashboardSummaryUseCase: GetDashboardSummaryUseCase
    private let keychainManager: KeychainManager

    init(getDashboardSummaryUseCase: GetDashboardSummaryUseCase, keychainManager: KeychainManager) {
        self.getDashboardSummaryUseCase = getDashboardSummaryUseCase
        self.keychainManager = keychainManager
    }

    func onEvent(_ event: DashboardUiEvent) {
        switch event {
        case .refresh: loadDashboard()
        case .searchChanged(let q): uiState.searchQuery = q
        case .navigate: break // handled by view
        }
    }

    private func loadDashboard() {
        let patientId = keychainManager.getPatientId() ?? 0
        uiState.isLoading = true
        Task {
            let result = await getDashboardSummaryUseCase(patientId: patientId)
            uiState.isLoading = false
            switch result {
            case .success(let summary):
                uiState.patientName = summary.patientName
                uiState.walletBalance = summary.walletBalance
                uiState.membershipStatus = summary.membershipStatus
                uiState.loyaltyPoints = summary.loyaltyPoints
                uiState.nextAppointment = summary.nextAppointment
                uiState.currency = summary.currency
            case .failure(let err):
                uiState.error = err.errorDescription
            }
        }
    }
}

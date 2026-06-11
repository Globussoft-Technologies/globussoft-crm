import Foundation
import Combine

@MainActor
final class LoyaltyViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var hasLoaded = false
    @Published var balance: LoyaltyBalance? = nil
    @Published var transactions: [LoyaltyTransaction] = []
    @Published var error: String? = nil

    private let getLoyaltyUseCase: GetLoyaltyUseCase
    private let keychain: KeychainManager

    init(getLoyaltyUseCase: GetLoyaltyUseCase, keychain: KeychainManager) {
        self.getLoyaltyUseCase = getLoyaltyUseCase
        self.keychain = keychain
    }

    func load() async {
        guard !isLoading else { return }
        guard let patientId = keychain.getPatientIdString() else {
            hasLoaded = true
            error = "Session error — please log out and log in again."
            return
        }
        isLoading = true
        error = nil
        let result = await getLoyaltyUseCase(patientId: patientId)
        isLoading = false
        hasLoaded = true
        switch result {
        case .success(let (bal, txs)):
            balance = bal
            transactions = txs
        case .failure(let e):
            if !Task.isCancelled { error = e.localizedDescription }
        }
    }
}

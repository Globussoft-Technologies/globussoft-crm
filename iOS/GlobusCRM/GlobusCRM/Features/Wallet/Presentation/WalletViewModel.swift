import Foundation
import Combine

@MainActor
final class WalletViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var hasLoaded = false
    @Published var balance: WalletBalance? = nil
    @Published var transactions: [WalletTransaction] = []
    @Published var filteredTransactions: [WalletTransaction] = []
    @Published var error: String? = nil
    @Published var selectedFilter: TransactionFilterType = .all

    private let getWalletUseCase: GetWalletUseCase
    private let keychain: KeychainManager

    init(getWalletUseCase: GetWalletUseCase, keychain: KeychainManager) {
        self.getWalletUseCase = getWalletUseCase
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
        let (balResult, txResult) = await getWalletUseCase(patientId: patientId)
        isLoading = false
        hasLoaded = true
        if case .success(let b) = balResult {
            balance = b
        }
        if case .success(let (_, txs)) = txResult {
            transactions = txs
            applyFilter()
        }
        if case .failure(let e) = balResult {
            if !Task.isCancelled { error = e.localizedDescription }
        }
    }

    // MARK: - KPI stats derived from transactions

    var totalPaid: Double {
        transactions.filter { $0.status == "success" || $0.status == "completed" || $0.status == "paid" }
                    .reduce(0) { $0 + $1.amount }
    }

    var totalPending: Double {
        transactions.filter { $0.status == "pending" }
                    .reduce(0) { $0 + $1.amount }
    }

    var giftCardsTotal: Double {
        transactions.filter { $0.category == "gift_cards" }
                    .reduce(0) { $0 + $1.amount }
    }

    var membershipsTotal: Double {
        transactions.filter { $0.category == "membership" }
                    .reduce(0) { $0 + $1.amount }
    }

    var statsCurrency: String { transactions.first?.currency ?? balance?.currency ?? "INR" }

    func setFilter(_ filter: TransactionFilterType) {
        selectedFilter = filter
        applyFilter()
    }

    private func applyFilter() {
        switch selectedFilter {
        case .all:
            filteredTransactions = transactions
        case .wallet:
            filteredTransactions = transactions.filter { $0.category == "wallet" }
        case .giftCards:
            filteredTransactions = transactions.filter { $0.category == "gift_cards" }
        case .memberships:
            filteredTransactions = transactions.filter { $0.category == "membership" }
        case .treatments:
            filteredTransactions = transactions.filter { $0.category == "treatments" }
        }
    }
}

enum TransactionFilterType: String, CaseIterable {
    case all        = "All"
    case wallet     = "Wallet"
    case giftCards  = "Gift Cards"
    case memberships = "Memberships"
    case treatments = "Treatments"
}

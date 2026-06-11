import Foundation

struct WalletBalance: Equatable {
    let balance: Double
    let currency: String
    let pendingCredits: Double
}

struct WalletTransaction: Identifiable, Equatable {
    let id: String
    let type: TransactionType
    let category: String       // wallet | gift_cards | membership | treatments
    let amount: Double
    let currency: String
    let description: String    // populated from title ?? description
    let date: String
    let status: String

    enum TransactionType: String {
        case credit = "credit"
        case debit  = "debit"
    }
}

struct GiftCard: Identifiable, Equatable {
    let id: String
    let name: String
    let amount: Double          // face value
    let price: Double           // purchase price
    let color: String?
    let validityDays: Int
    let currency: String
    let expiresAt: String?
    let purchasedAt: String?    // populated for owned cards (from payments API)
    let paymentStatus: String?  // "SUCCESS" | "PENDING" for owned cards
}

import Foundation

struct LoyaltyBalance: Equatable {
    let points: Int
    let earnedThisMonth: Int
    let currency: String
}

struct LoyaltyTransaction: Identifiable, Equatable {
    let id: String
    let points: Int
    let description: String
    let date: String
    let type: LoyaltyTransactionType
}

enum LoyaltyTransactionType: String {
    case earned   = "earned"
    case redeemed = "redeemed"
    case expired  = "expired"
    case bonus    = "bonus"
}

import Foundation

// GET /wellness/loyalty/{patientId} — returns everything in one response, no `data` wrapper
struct LoyaltyDataResponseDTO: Decodable {
    let balance: Int
    let earnedThisMonth: Int?
    let transactions: [LoyaltyTxnDTO]?
}

struct LoyaltyTxnDTO: Decodable {
    let id: Int
    let type: String?
    let points: Int?
    let reason: String?
    let createdAt: String?
}

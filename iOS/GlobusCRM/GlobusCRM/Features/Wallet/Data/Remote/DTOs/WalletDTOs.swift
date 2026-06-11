import Foundation

// GET /wellness/patients/{patientId}/wallet
// Backend returns: { patient: {...}, wallet: { balance, currency, ... }, transactions: [...] }
struct WalletBalanceResponseDTO: Decodable {
    let wallet: WalletDetailDTO
}

struct WalletDetailDTO: Decodable {
    let balance: Double?
    let currency: String?
}

// GET /wellness/giftcards/storefront
// Backend returns: { giftCards: [{ id, name, amount, price, color, validityDays, currency, expiresAt }] }
struct GiftCardsResponseDTO: Decodable {
    let giftCards: [StorefrontGiftCardDTO]
}

struct StorefrontGiftCardDTO: Decodable {
    let id: Int
    let name: String?
    let amount: Double?
    let price: Double?
    let color: String?
    let validityDays: Int?
    let currency: String?
    let expiresAt: String?
}

// POST /wellness/portal/giftcards/redeem
struct RedeemGiftCardResponseDTO: Decodable {
    let success: Bool?
    let message: String?
}

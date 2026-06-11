import Foundation

extension LoyaltyDataResponseDTO {
    func toDomain() -> (LoyaltyBalance, [LoyaltyTransaction]) {
        let balance = LoyaltyBalance(
            points: self.balance,
            earnedThisMonth: earnedThisMonth ?? 0,
            currency: "pts"
        )
        let txs = (transactions ?? []).map { $0.toDomain() }
        return (balance, txs)
    }
}

extension LoyaltyTxnDTO {
    func toDomain() -> LoyaltyTransaction {
        LoyaltyTransaction(
            id: String(id),
            points: points ?? 0,
            description: reason ?? "",
            date: createdAt ?? "",
            type: LoyaltyTransactionType(rawValue: type ?? "earned") ?? .earned
        )
    }
}

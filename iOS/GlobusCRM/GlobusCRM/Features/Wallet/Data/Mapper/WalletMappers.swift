import Foundation

extension WalletDetailDTO {
    func toDomain() -> WalletBalance {
        WalletBalance(
            balance: balance ?? 0,
            currency: currency ?? "INR",
            pendingCredits: 0
        )
    }
}

extension TransactionDTO {
    func toWalletDomain(currency: String) -> WalletTransaction {
        WalletTransaction(
            id: id,
            type: direction == "credit" ? .credit : .debit,
            category: category ?? "wallet",
            amount: amount,
            currency: currency,
            description: title ?? description ?? "",
            date: date ?? "",
            status: status ?? "completed"
        )
    }
}

extension StorefrontGiftCardDTO {
    func toDomain() -> GiftCard {
        GiftCard(
            id: String(id),
            name: name ?? "Gift Card",
            amount: amount ?? 0,
            price: price ?? amount ?? 0,
            color: color,
            validityDays: validityDays ?? 365,
            currency: currency ?? "INR",
            expiresAt: expiresAt,
            purchasedAt: nil,
            paymentStatus: nil
        )
    }
}

// MARK: - PaymentDTO → wallet types
// Both wallet transactions and purchased gift cards derive from /api/payments

extension PaymentDTO {
    func toWalletTransaction() -> WalletTransaction {
        let category: String = {
            switch metadata?.kind {
            case "giftcard_purchase":   return "gift_cards"
            case "membership_purchase": return "membership"
            default:                    return "wallet"
            }
        }()
        return WalletTransaction(
            id: String(id),
            type: .debit,
            category: category,
            amount: amount ?? 0,
            currency: currency ?? "INR",
            description: descriptionFromMetadata,
            date: paidAt ?? createdAt ?? "",
            status: (status ?? "PENDING").lowercased()
        )
    }

    func toPurchasedGiftCard() -> GiftCard {
        GiftCard(
            id: String(id),
            name: "Gift Card",
            amount: amount ?? 0,
            price: amount ?? 0,
            color: nil,
            validityDays: 365,
            currency: currency ?? "INR",
            expiresAt: nil,
            purchasedAt: paidAt ?? createdAt,
            paymentStatus: status
        )
    }
}

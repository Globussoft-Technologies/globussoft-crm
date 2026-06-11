import Foundation

struct Payment: Identifiable, Equatable {
    let id: String
    let amount: Double
    let currency: String
    let status: PaymentStatus
    let method: String
    let description: String
    let date: String
    let invoiceNumber: String?
    let refundable: Bool

    enum PaymentStatus: String, Equatable {
        case paid      = "paid"
        case pending   = "pending"
        case failed    = "failed"
        case refunded  = "refunded"
        case partial   = "partial"
        case cancelled = "cancelled"

        var displayLabel: String {
            switch self {
            case .paid:      return "Paid"
            case .pending:   return "Pending"
            case .failed:    return "Failed"
            case .refunded:  return "Refunded"
            case .partial:   return "Partial"
            case .cancelled: return "Cancelled"
            }
        }
    }
}

struct PaymentsConfig: Equatable {
    let razorpayEnabled: Bool
    let stripeEnabled: Bool
    let currency: String
    let gatewayPublicKey: String?
}

import Foundation

// GET /payments — plain array of payment records
// id is an integer; status values are UPPERCASE from the server.
struct PaymentMetadataDTO: Codable {
    let kind: String?       // "giftcard_purchase" | "membership_purchase"
    let giftCardId: Int?
}

struct PaymentDTO: Codable {
    let id: Int
    let amount: Double?
    let currency: String?
    let status: String?
    let gateway: String?
    let gatewayId: String?
    let paidAt: String?
    let createdAt: String?
    let invoiceId: Int?
    let metadata: PaymentMetadataDTO?

    func toDomain() -> Payment {
        Payment(
            id: String(id),
            amount: amount ?? 0,
            currency: currency ?? "INR",
            status: Payment.PaymentStatus(rawValue: (status ?? "").lowercased()) ?? .pending,
            method: gateway ?? "—",
            description: descriptionFromMetadata,
            date: paidAt ?? createdAt ?? "",
            invoiceNumber: invoiceId.map { String($0) },
            refundable: false
        )
    }

    var descriptionFromMetadata: String {
        switch metadata?.kind {
        case "giftcard_purchase":   return "Gift Card Purchase"
        case "membership_purchase": return "Membership Purchase"
        default:                    return gateway?.capitalized ?? ""
        }
    }
}

// GET /payments/config — flat response, no `data` wrapper
// Returns gateway configuration status
struct PaymentsConfigResponseDTO: Codable {
    let stripe: GatewayStatusDTO?
    let razorpay: GatewayStatusDTO?

    func toDomain() -> PaymentsConfig {
        PaymentsConfig(
            razorpayEnabled: razorpay?.configured ?? false,
            stripeEnabled: stripe?.configured ?? false,
            currency: "INR",
            gatewayPublicKey: nil
        )
    }
}

struct GatewayStatusDTO: Codable {
    let configured: Bool?
}

struct RefundResponseDTO: Decodable {
    let success: Bool?
    let message: String?
}

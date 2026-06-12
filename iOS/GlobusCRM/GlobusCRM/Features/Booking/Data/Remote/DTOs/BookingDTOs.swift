import Foundation

// Request DTOs
struct BookAppointmentDTO: Encodable {
    let appointmentDate: String   // "YYYY-MM-DD" — NOT ISO8601 with time component
    let appointmentTime: String   // "HH:mm"
    let reason: String
    let doctorId: Int?
    let serviceId: Int?
    let membershipId: Int?
    let bookingType: String? = nil
}

struct RescheduleDTO: Encodable {
    let appointmentDate: String
    let appointmentTime: String
}

struct AddWaitlistDTO: Encodable {
    let serviceId: Int
    let patientId: Int
    let notes: String?
}

// Response DTOs
nonisolated struct AppointmentDTO: Decodable {
    let id: Int
    let doctorName: String?
    let serviceName: String?
    let appointmentDate: String
    let status: String
    let reason: String?
    let doctorAssigned: Bool?
    let bookingType: String?
    let videoCallUrl: String?
    let canCancel: Bool?
    let canReschedule: Bool?
}

nonisolated struct AppointmentListResponseDTO: Decodable {
    let bucket: String
    let count: Int
    let appointments: [AppointmentDTO]
}

struct BookingResponseDTO: Decodable {
    let success: Bool
    let appointment: AppointmentDTO
}

struct VisitDTO: Decodable {
    let id: Int
    let visitDate: String
    let status: String
    let service: ServiceRef?
    let doctor: DoctorRef?
    let locationName: String?
    let bookingType: String?
    let videoCallUrl: String?
    let amountCharged: Double?

    struct ServiceRef: Decodable { let id: Int; let name: String }
    struct DoctorRef: Decodable { let id: Int; let name: String }
}

struct WaitlistEntryDTO: Decodable {
    let id: Int
    let serviceId: Int
    let serviceName: String?
    let status: String
    let notes: String?
    let createdAt: String
}

struct DoctorAvailabilityDTO: Decodable {
    let id: Int
    let name: String
}

struct ProductDTO: Decodable {
    let id: Int
    let name: String
    let description: String?
    let basePrice: Double?
    let discountedPrice: Double?
    let categoryId: Int?
    let category: String?
    let durationMin: Int?
    let isActive: Bool?
}

// Shared across dashboard + wallet
nonisolated struct MyTransactionsResponseDTO: Decodable {
    let currency: String
    let summary: Summary
    let transactions: [TransactionDTO]

    nonisolated struct Summary: Decodable {
        let totalPaid: Double?
        let posTotal: Double?
        let onlineTotal: Double?
        let subscriptionsTotal: Double?
        let walletBalance: Double?
        let walletTopUps: Double?
        let transactionCount: Int?
    }
}

nonisolated struct TransactionDTO: Decodable {
    let id: String
    let type: String?
    let category: String?
    let title: String?
    let description: String?
    let amount: Double
    let direction: String?    // "credit" | "debit"
    let status: String?
    let reference: String?
    let date: String?
    let paymentMethod: String?
    let balanceAfter: Double?
}

struct MembershipDTO: Decodable {
    let id: Int
    let planId: Int?
    let planName: String?
    let planDurationDays: Int?
    let startDate: String?
    let endDate: String?
    let status: String
    let balance: [AnyCodable]?
}

struct LoyaltyResponseDTO: Decodable {
    let balance: Int
    let earnedThisMonth: Int?
    let transactions: [LoyaltyTransaction]?

    struct LoyaltyTransaction: Decodable {
        let id: Int
        let type: String
        let points: Int
        let reason: String?
        let createdAt: String
    }
}

// Helpers
struct AnyCodable: Codable {
    init(from decoder: Decoder) throws {}
    func encode(to encoder: Encoder) throws {}
}

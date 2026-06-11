import Foundation

struct Visit: Identifiable {
    let id: Int
    let visitDate: String
    let status: String
    let serviceName: String
    let doctorName: String
    let locationName: String?
    let bookingType: String?
    let videoCallUrl: String?
    let amountCharged: Double
}

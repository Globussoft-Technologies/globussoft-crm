import Foundation

struct WaitlistEntry: Identifiable {
    let id: Int
    let serviceId: Int
    let serviceName: String?
    let status: WaitlistStatus
    let notes: String?
    let createdAt: String

    enum WaitlistStatus: String {
        case pending, notified, cancelled
    }
}

import Foundation

struct TreatmentPlan: Identifiable, Equatable {
    let id: String
    let name: String
    let serviceName: String?
    let serviceCategory: String?
    let startedAt: String?
    let nextDueAt: String?
    let sessionsTotal: Int
    let sessionsCompleted: Int
    let status: String
    let totalPrice: Double?

    var progressFraction: Double {
        guard sessionsTotal > 0 else { return 0 }
        return Double(sessionsCompleted) / Double(sessionsTotal)
    }
}

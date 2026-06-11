import Foundation

struct DeepLinkHandler {
    // Resolves wellnesspatient://screen/{name}?id={entityId}
    static func resolve(url: URL) -> AppRoute? {
        guard url.scheme == "wellnesspatient", url.host == "screen" else { return nil }
        let screen = url.lastPathComponent
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let idString = components?.queryItems?.first(where: { $0.name == "id" })?.value
        let id = idString.flatMap { Int($0) }

        switch screen {
        case "dashboard":            return .dashboard
        case "appointments":         return .myAppointments
        case "book":                 return .bookAppointment()
        case "visitHistory":         return .visitHistory
        case "waitlist":             return .waitlist
        case "prescriptions":        return .prescriptions
        case "prescription":         return id.map { .prescriptionPdf(prescriptionId: $0) }
        case "treatmentPlans":       return .treatmentPlans
        case "consentForms":         return .consentForms
        case "wallet":               return .wallet
        case "giftCards":            return .giftCards
        case "memberships":          return .memberships
        case "notifications":        return .notificationInbox
        case "notificationSettings": return .notificationSettings
        case "catalog":              return .catalog
        case "finance":              return .finance
        case "loyalty":              return .loyalty
        default:                     return nil
        }
    }
}

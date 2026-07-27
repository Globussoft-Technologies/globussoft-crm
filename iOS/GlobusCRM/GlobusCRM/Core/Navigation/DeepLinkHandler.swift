import Foundation

struct DeepLinkHandler {
    // Resolves wellnesspatient://screen/{name}?id={entityId}
    // Also accepts Android's globuscrm://screen/{name} scheme for parity.
    static func resolve(url: URL) -> AppRoute? {
        guard let scheme = url.scheme,
              ["wellnesspatient", "globuscrm"].contains(scheme),
              url.host == "screen" else { return nil }
        guard let screen = NotificationRouteMapper.canonicalScreen(from: url.path) else { return nil }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let idString = components?.queryItems?.first(where: { $0.name == "id" })?.value
        let visitIdString = components?.queryItems?.first(where: { $0.name == "visitId" })?.value
        let id = idString.flatMap { Int($0) }

        switch screen {
        case "dashboard":            return .dashboard
        case "appointments":         return .myAppointments
        case "book":                 return .bookAppointment()
        case "visitHistory":         return .visitHistory
        case "waitlist":             return .waitlist
        case "prescriptions":        return .prescriptions
        case "prescription":         return id.map { .prescriptionPdf(prescriptionId: $0) }
        case "prescription_analysis":
            return idString.map { .treatmentAnalysis(prescriptionId: $0, visitId: visitIdString) }
        case "treatmentPlans":       return .treatmentPlans
        case "consentForms":         return .consentForms
        case "wallet":               return .wallet
        case "giftCards":            return .giftCards
        case "memberships":          return .memberships
        case "profile":              return .profile
        case "notifications":        return .notificationInbox
        case "notificationSettings": return .notificationSettings
        case "catalog":              return .catalog
        case "finance":              return .finance
        case "loyalty":              return .loyalty
        default:                     return nil
        }
    }

    static func url(screenOrLink rawValue: String, entityId: String?) -> URL? {
        if let url = URL(string: rawValue),
           url.scheme != nil,
           resolve(url: url) != nil {
            return url
        }
        guard let screen = NotificationRouteMapper.canonicalScreen(from: rawValue) else { return nil }
        var components = URLComponents()
        components.scheme = "wellnesspatient"
        components.host = "screen"
        components.path = "/\(screen)"
        if let entityId, !entityId.isEmpty {
            components.queryItems = [URLQueryItem(name: "id", value: entityId)]
        }
        return components.url
    }
}

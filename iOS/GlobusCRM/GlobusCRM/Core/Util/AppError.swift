import Foundation

enum AppError: Error, LocalizedError {
    case unauthorized
    case http(statusCode: Int, message: String, serverCode: String?)
    case network(String)
    case decoding(String)
    case unknown(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Session expired. Please log in again."
        case .http(_, let message, _):
            return message
        case .network(let msg):
            return msg
        case .decoding(let msg):
            return "Data error: \(msg)"
        case .unknown(let msg):
            return msg
        }
    }
}

extension AppError: Equatable {
    static func == (lhs: AppError, rhs: AppError) -> Bool {
        switch (lhs, rhs) {
        case (.unauthorized, .unauthorized): return true
        case (.network(let a), .network(let b)): return a == b
        case (.http(let s1, _, _), .http(let s2, _, _)): return s1 == s2
        default: return false
        }
    }
}

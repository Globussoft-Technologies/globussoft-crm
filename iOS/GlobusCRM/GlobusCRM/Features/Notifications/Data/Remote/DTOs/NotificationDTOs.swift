import Foundation

// GET /wellness/portal/me/notifications — endpoint not yet implemented in backend
// Response shape reserved for future use
struct NotificationListResponseDTO: Codable {
    let notifications: [NotificationItemDTO]?
    let total: Int?
    let page: Int?
}

struct NotificationItemDTO: Codable {
    let id: Int
    let type: String?
    let title: String?
    let body: String?
    let screen: String?
    let entityId: Int?
    let isRead: Bool?
    let createdAt: String?
}

struct MarkReadResponseDTO: Codable {
    let success: Bool?
    let message: String?
}

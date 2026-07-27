import Foundation

// GET /wellness/portal/me/notifications
struct NotificationListResponseDTO: Decodable {
    let notifications: [NotificationItemDTO]?
    let total: Int?
    let page: Int?
    let unreadCount: Int?

    private enum CodingKeys: String, CodingKey {
        case notifications
        case total
        case page
        case unreadCount
        case count
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        notifications = try container.decodeIfPresent([NotificationItemDTO].self, forKey: .notifications)
        total = try container.decodeIfPresent(Int.self, forKey: .total)
            ?? container.decodeIfPresent(Int.self, forKey: .count)
        page = try container.decodeIfPresent(Int.self, forKey: .page)
        unreadCount = try container.decodeIfPresent(Int.self, forKey: .unreadCount)
    }
}

struct NotificationItemDTO: Decodable {
    let id: Int
    let type: String?
    let title: String?
    let body: String?
    let screen: String?
    let entityId: Int?
    let isRead: Bool?
    let createdAt: String?

    private enum CodingKeys: String, CodingKey {
        case id
        case type
        case title
        case body
        case message
        case screen
        case link
        case entityId
        case isRead
        case createdAt
        case receivedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        type = try container.decodeIfPresent(String.self, forKey: .type)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        body = try container.decodeIfPresent(String.self, forKey: .body)
            ?? container.decodeIfPresent(String.self, forKey: .message)
        screen = try container.decodeIfPresent(String.self, forKey: .screen)
            ?? container.decodeIfPresent(String.self, forKey: .link)
        entityId = try container.decodeIfPresent(Int.self, forKey: .entityId)
        isRead = try container.decodeIfPresent(Bool.self, forKey: .isRead)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
            ?? container.decodeIfPresent(String.self, forKey: .receivedAt)
    }
}

struct MarkReadResponseDTO: Decodable {
    let success: Bool?
    let message: String?
}

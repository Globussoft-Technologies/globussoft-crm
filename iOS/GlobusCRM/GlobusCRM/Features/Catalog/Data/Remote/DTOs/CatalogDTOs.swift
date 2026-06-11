import Foundation

// Backend returns direct arrays, not wrapped objects.
// IDs are integers in the API; they are converted to String in the domain mapper.
struct ServiceDTO: Codable {
    let id: Int
    let name: String?
    let description: String?
    let basePrice: Double?
    let discountedPrice: Double?
    let currency: String?
    let durationMin: Int?
    let categoryId: Int?
    // Backend field is `category` (the category name string), not `categoryName`
    let categoryName: String?
    // Backend field is `imageUrls` (JSON-stringified array of URLs)
    let imageUrls: String?
    let isActive: Bool?

    enum CodingKeys: String, CodingKey {
        case id, name, description, basePrice, discountedPrice, currency
        case durationMin, categoryId, imageUrls, isActive
        case categoryName = "category"
    }
}

struct CategoryDTO: Codable {
    let id: Int
    let name: String?
    let description: String?
    let imageUrl: String?
    let color: String?
    let parentId: Int?
    let displayOrder: Int?
    let isActive: Bool?
    // Server sends `_count: { services: N, children: N }`
    let count: CategoryCountDTO?

    enum CodingKeys: String, CodingKey {
        case id, name, description, imageUrl, color, parentId, displayOrder, isActive
        case count = "_count"
    }
}

struct CategoryCountDTO: Codable {
    let services: Int?
    let children: Int?
}

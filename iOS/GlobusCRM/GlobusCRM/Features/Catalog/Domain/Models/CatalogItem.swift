import Foundation

struct ServiceCatalogItem: Identifiable, Equatable {
    let id: String
    let name: String
    let description: String?
    let price: Double
    let discountedPrice: Double?
    let currency: String
    let durationMinutes: Int?
    let categoryId: String?
    let categoryName: String?
    let imageUrl: String?
    let isActive: Bool
}

struct ServiceCategory: Identifiable, Equatable {
    let id: String
    let name: String
    let description: String?
    let serviceCount: Int   // children count from _count.children (sub-categories)
    let imageUrl: String?   // replaces non-existent iconName field
    let color: String?      // hex color from API (e.g. "#2196f3")
    let parentId: String?   // nil = top-level category
}

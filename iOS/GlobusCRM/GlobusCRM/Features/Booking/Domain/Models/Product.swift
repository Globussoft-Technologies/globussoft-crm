import Foundation

struct Product: Identifiable {
    let id: Int
    let name: String
    let description: String?
    let basePrice: Double?
    let discountedPrice: Double?
    let categoryId: Int?
    let category: String?
    let durationMin: Int?
    let isActive: Bool
}

struct DoctorOption: Identifiable {
    let id: Int?                // nil = "No preference"
    let name: String
}

struct ProductCategory: Identifiable {
    let id: Int
    let name: String
    let color: String?
    let serviceCount: Int
}

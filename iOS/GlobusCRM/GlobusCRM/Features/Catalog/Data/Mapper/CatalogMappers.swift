import Foundation

extension ServiceDTO {
    func toDomain() -> ServiceCatalogItem {
        // imageUrls is a JSON-stringified array e.g. `["https://..."]` — extract first URL
        var firstImageUrl: String? = nil
        if let raw = imageUrls,
           let data = raw.data(using: .utf8),
           let arr = try? JSONSerialization.jsonObject(with: data) as? [String],
           let first = arr.first {
            firstImageUrl = first
        }
        return ServiceCatalogItem(
            id: String(id),
            name: name ?? "Service",
            description: description,
            price: basePrice ?? 0,
            discountedPrice: discountedPrice,
            currency: currency ?? "INR",
            durationMinutes: durationMin,
            categoryId: categoryId.map { String($0) },
            categoryName: categoryName,
            imageUrl: firstImageUrl,
            isActive: isActive ?? true
        )
    }
}

extension CategoryDTO {
    func toDomain() -> ServiceCategory {
        ServiceCategory(
            id: String(id),
            name: name ?? "Category",
            description: description,
            serviceCount: count?.services ?? 0,
            imageUrl: imageUrl,
            color: color,
            parentId: parentId.map { String($0) }
        )
    }
}

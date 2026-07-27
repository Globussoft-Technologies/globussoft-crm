import Foundation

extension ServiceDTO {
    func toDomain() -> ServiceCatalogItem {
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
            imageUrl: ImageURLParser.firstURL(list: imageUrls),
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

import Foundation

final class GetServicesUseCase {
    private let repository: CatalogRepository
    init(repository: CatalogRepository) { self.repository = repository }
    func callAsFunction() async -> Result<[ServiceCatalogItem], AppError> {
        await repository.getServices()
    }
}

final class GetCategoriesUseCase {
    private let repository: CatalogRepository
    init(repository: CatalogRepository) { self.repository = repository }
    func callAsFunction() async -> Result<[ServiceCategory], AppError> {
        await repository.getCategories()
    }
}

final class GetServiceDetailUseCase {
    private let repository: CatalogRepository
    init(repository: CatalogRepository) { self.repository = repository }
    func callAsFunction(id: String) async -> Result<ServiceCatalogItem, AppError> {
        await repository.getServiceDetail(id: id)
    }
}

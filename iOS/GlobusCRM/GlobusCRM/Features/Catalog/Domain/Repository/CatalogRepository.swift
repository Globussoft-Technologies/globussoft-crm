import Foundation

protocol CatalogRepository {
    func getServices() async -> Result<[ServiceCatalogItem], AppError>
    func getCategories() async -> Result<[ServiceCategory], AppError>
    func getServiceDetail(id: String) async -> Result<ServiceCatalogItem, AppError>
}

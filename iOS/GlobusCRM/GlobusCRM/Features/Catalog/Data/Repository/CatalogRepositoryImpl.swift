import Foundation

final class CatalogRepositoryImpl: CatalogRepository {
    private let apiClient: WellnessAPIClient

    init(apiClient: WellnessAPIClient) {
        self.apiClient = apiClient
    }

    func getServices() async -> Result<[ServiceCatalogItem], AppError> {
        let result: Result<[ServiceDTO], AppError> = await apiClient.request(endpoint: .getServices)
        return result.map { $0.map { $0.toDomain() } }
    }

    func getCategories() async -> Result<[ServiceCategory], AppError> {
        let result: Result<[CategoryDTO], AppError> = await apiClient.request(endpoint: .getCategories)
        return result.map { $0.map { $0.toDomain() } }
    }

    func getServiceDetail(id: String) async -> Result<ServiceCatalogItem, AppError> {
        let result: Result<ServiceDTO, AppError> = await apiClient.request(
            endpoint: .getServiceDetail(id: id)
        )
        return result.map { $0.toDomain() }
    }
}

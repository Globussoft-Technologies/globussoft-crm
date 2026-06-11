import Foundation
import Combine

@MainActor
final class CatalogViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var services: [ServiceCatalogItem] = []
    @Published var categories: [ServiceCategory] = []
    @Published var filteredServices: [ServiceCatalogItem] = []
    @Published var searchText = ""
    @Published var selectedCategory: ServiceCategory? = nil
    @Published var selectedService: ServiceCatalogItem? = nil
    @Published var error: String? = nil

    private let getServicesUseCase: GetServicesUseCase
    private let getCategoriesUseCase: GetCategoriesUseCase
    private var cancellables = Set<AnyCancellable>()

    init(getServicesUseCase: GetServicesUseCase, getCategoriesUseCase: GetCategoriesUseCase) {
        self.getServicesUseCase = getServicesUseCase
        self.getCategoriesUseCase = getCategoriesUseCase

        $searchText
            .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.applyFilters() }
            .store(in: &cancellables)
    }

    func load() async {
        isLoading = true
        error = nil
        async let sResult = getServicesUseCase()
        async let cResult = getCategoriesUseCase()
        let (servicesResult, categoriesResult) = await (sResult, cResult)
        isLoading = false
        if case .success(let s) = servicesResult { services = s; applyFilters() }
        if case .success(let c) = categoriesResult { categories = c }
        if case .failure(let e) = servicesResult  { error = e.localizedDescription }
        if case .failure(let e) = categoriesResult, error == nil { error = e.localizedDescription }
    }

    func selectCategory(_ category: ServiceCategory?) {
        selectedCategory = category
        applyFilters()
    }

    func selectService(_ service: ServiceCatalogItem) {
        selectedService = service
    }

    func dismissServiceDetail() {
        selectedService = nil
    }

    private func applyFilters() {
        var result = services
        if let cat = selectedCategory {
            // Match by categoryId (primary) OR categoryName (fallback) — mirrors Android's name-based approach
            result = result.filter { $0.categoryId == cat.id || $0.categoryName == cat.name }
        }
        if !searchText.isEmpty {
            let q = searchText.lowercased()
            result = result.filter { $0.name.lowercased().contains(q) || ($0.description?.lowercased().contains(q) ?? false) }
        }
        filteredServices = result
    }

    static var placeholder: CatalogViewModel {
        fatalError("Inject via AppContainer")
    }
}

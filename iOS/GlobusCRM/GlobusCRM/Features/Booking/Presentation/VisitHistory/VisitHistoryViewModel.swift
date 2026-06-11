import Foundation
import Combine

@MainActor
final class VisitHistoryViewModel: ObservableObject {
    @Published private(set) var visits: [Visit] = []
    @Published private(set) var isLoading = false
    @Published private(set) var hasLoaded = false
    @Published var error: String? = nil

    private let getVisitHistoryUseCase: GetVisitHistoryUseCase

    init(getVisitHistoryUseCase: GetVisitHistoryUseCase) {
        self.getVisitHistoryUseCase = getVisitHistoryUseCase
    }

    func load() async {
        isLoading = true
        let result = await getVisitHistoryUseCase()
        isLoading = false
        hasLoaded = true
        if case .success(let v) = result { visits = v }
        else if case .failure(let e) = result { error = e.errorDescription }
    }

    var groupedMonths: [String] {
        Array(Set(visits.map { DateUtil.monthLabel(from: $0.visitDate) })).sorted(by: >)
    }

    func visits(for month: String) -> [Visit] {
        visits.filter { DateUtil.monthLabel(from: $0.visitDate) == month }
    }

    static var placeholder: VisitHistoryViewModel {
        fatalError("Inject via AppContainer")
    }
}

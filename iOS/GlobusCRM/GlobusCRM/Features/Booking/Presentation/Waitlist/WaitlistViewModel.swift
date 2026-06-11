import Foundation
import Combine

@MainActor
final class WaitlistViewModel: ObservableObject {
    @Published private(set) var entries: [WaitlistEntry] = []
    @Published private(set) var services: [Product] = []
    @Published var selectedServiceId: Int? = nil
    @Published var isLoading = false
    @Published var error: String? = nil

    private let getWaitlistUseCase: GetWaitlistUseCase
    private let addToWaitlistUseCase: AddToWaitlistUseCase
    private let repository: AppointmentRepository

    init(getWaitlistUseCase: GetWaitlistUseCase,
         addToWaitlistUseCase: AddToWaitlistUseCase,
         repository: AppointmentRepository) {
        self.getWaitlistUseCase = getWaitlistUseCase
        self.addToWaitlistUseCase = addToWaitlistUseCase
        self.repository = repository
    }

    func load() async {
        isLoading = true
        async let waitlistResult = getWaitlistUseCase()
        async let servicesResult = (try? await repository.getServices()) ?? []
        let waitlist = await waitlistResult
        let svcs = await servicesResult
        isLoading = false
        if case .success(let e) = waitlist { entries = e }
        services = svcs
    }

    func addToWaitlist(notes: String?) async {
        guard let serviceId = selectedServiceId else { return }
        let result = await addToWaitlistUseCase(serviceId: serviceId, notes: notes)
        if case .success(let entry) = result { entries.append(entry) }
    }

    static var placeholder: WaitlistViewModel {
        fatalError("Inject via AppContainer")
    }
}

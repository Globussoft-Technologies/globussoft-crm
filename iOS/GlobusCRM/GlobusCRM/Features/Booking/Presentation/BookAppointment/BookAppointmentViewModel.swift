import Foundation
import Combine

@MainActor
final class BookAppointmentViewModel: ObservableObject {
    @Published var uiState = BookAppointmentUiState()

    private let bookUseCase: BookAppointmentUseCase
    private let repository: AppointmentRepository

    init(bookUseCase: BookAppointmentUseCase, repository: AppointmentRepository) {
        self.bookUseCase = bookUseCase
        self.repository = repository
    }

    func onEvent(_ event: BookAppointmentUiEvent) {
        switch event {
        case .loadServices:           loadServices()
        case .selectService(let s):   uiState.selectedService = s; uiState.step = 2; loadDoctors()
        case .searchChanged(let q):   uiState.serviceSearchQuery = q
        case .loadDoctors:            loadDoctors()
        case .selectDoctor(let opt):  uiState.selectedDoctorId = opt.id; uiState.selectedDoctorName = opt.name; uiState.step = 3
        case .nextStep:               uiState.step += 1
        case .dateChanged(let d):     uiState.selectedDate = d
        case .timeChanged(let t):     uiState.selectedTime = t
        case .reasonChanged(let r):   uiState.reason = r
        case .membershipChanged(let m): uiState.membershipId = m
        case .confirm:                confirmBooking()
        case .back:                   if uiState.step > 1 { uiState.step -= 1 }
        case .reset:                  uiState = BookAppointmentUiState()
        }
    }

    var filteredServices: [Product] {
        let q = uiState.serviceSearchQuery.lowercased()
        guard !q.isEmpty else { return uiState.services }
        return uiState.services.filter { $0.name.lowercased().contains(q) }
    }

    private func loadServices() {
        uiState.isLoading = true
        uiState.error = nil
        Task {
            do {
                uiState.services = try await repository.getServices()
            } catch {
                uiState.error = error.localizedDescription
            }
            uiState.isLoading = false
        }
    }

    private func loadDoctors() {
        let dateStr = DateUtil.toApiDate(uiState.selectedDate)
        Task {
            uiState.doctors = (try? await repository.getDoctorAvailability(date: dateStr)) ?? [DoctorOption(id: nil, name: "No preference")]
        }
    }

    private func confirmBooking() {
        guard !uiState.reason.isEmpty else { uiState.error = "Please enter a reason."; return }
        let request = BookAppointmentRequest(
            appointmentDate: DateUtil.toApiDate(uiState.selectedDate),
            appointmentTime: uiState.selectedTime,
            reason: uiState.reason,
            doctorId: uiState.selectedDoctorId,
            serviceId: uiState.selectedService?.id,
            membershipId: uiState.membershipId
        )
        uiState.isBooking = true
        Task {
            let result = await bookUseCase(request)
            uiState.isBooking = false
            switch result {
            case .success(let appt): uiState.bookingSuccess = appt; uiState.step = 5
            case .failure(let err):  uiState.error = err.errorDescription
            }
        }
    }

    static var placeholder: BookAppointmentViewModel {
        fatalError("Inject via AppContainer")
    }
}

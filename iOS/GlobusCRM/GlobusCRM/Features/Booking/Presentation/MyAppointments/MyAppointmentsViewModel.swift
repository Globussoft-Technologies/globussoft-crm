import Foundation
import Combine

@MainActor
final class MyAppointmentsViewModel: ObservableObject {
    @Published var uiState = MyAppointmentsUiState()

    private let getMyAppointmentsUseCase: GetMyAppointmentsUseCase
    private let cancelUseCase: CancelAppointmentUseCase
    private let rescheduleUseCase: RescheduleAppointmentUseCase

    init(getMyAppointmentsUseCase: GetMyAppointmentsUseCase,
         cancelUseCase: CancelAppointmentUseCase,
         rescheduleUseCase: RescheduleAppointmentUseCase) {
        self.getMyAppointmentsUseCase = getMyAppointmentsUseCase
        self.cancelUseCase = cancelUseCase
        self.rescheduleUseCase = rescheduleUseCase
    }

    func onEvent(_ event: MyAppointmentsUiEvent) {
        switch event {
        case .refresh:
            loadAllBuckets()
        case .selectBucket(let b):
            uiState.selectedBucket = b
            if uiState.appointments[b.rawValue] == nil {
                loadBucket(b)
            }
        case .tapAppointment(let a):      uiState.selectedAppointment = a; uiState.activeSheet = .actions
        case .dismissActionSheet:         uiState.activeSheet = nil
        case .viewDetails:                uiState.activeSheet = .detail
        case .reschedule(let id, let d, let t): reschedule(id: id, date: d, time: t)
        case .cancelAppointment(let id):  cancel(id: id)
        }
    }

    private func loadAllBuckets() {
        uiState.isLoading = true
        uiState.error = nil
        Task {
            async let upcomingResult = getMyAppointmentsUseCase(bucket: "upcoming")
            async let pendingResult = getMyAppointmentsUseCase(bucket: "pending")
            async let completedResult = getMyAppointmentsUseCase(bucket: "past")
            async let cancelledResult = getMyAppointmentsUseCase(bucket: "cancelled")
            let (r1, r2, r3, r4) = await (upcomingResult, pendingResult, completedResult, cancelledResult)
            uiState.isLoading = false
            let pairs: [(String, Result<[Appointment], AppError>)] = [
                ("upcoming", r1), ("pending", r2), ("past", r3), ("cancelled", r4)
            ]
            for (key, result) in pairs {
                if case .success(let appts) = result {
                    uiState.appointments[key] = appts
                } else if case .failure(let err) = result, key == uiState.selectedBucket.rawValue {
                    uiState.error = err.errorDescription
                }
            }
        }
    }

    private func loadBucket(_ bucket: AppointmentBucket) {
        Task {
            let result = await getMyAppointmentsUseCase(bucket: bucket.rawValue)
            if case .success(let appts) = result {
                uiState.appointments[bucket.rawValue] = appts
            }
        }
    }

    private func cancel(id: Int) {
        Task {
            _ = await cancelUseCase(id: id)
            loadAllBuckets()
        }
    }

    private func reschedule(id: Int, date: String, time: String) {
        Task {
            _ = await rescheduleUseCase(id: id, date: date, time: time)
            uiState.activeSheet = nil
            loadAllBuckets()
        }
    }
}

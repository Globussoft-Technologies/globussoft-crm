import Foundation

final class GetMyAppointmentsUseCase {
    private let repository: AppointmentRepository
    init(repository: AppointmentRepository) { self.repository = repository }

    func callAsFunction(bucket: String) async -> Result<[Appointment], AppError> {
        do { return .success(try await repository.getMyAppointments(bucket: bucket)) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }
}

final class BookAppointmentUseCase {
    private let repository: AppointmentRepository
    init(repository: AppointmentRepository) { self.repository = repository }

    func callAsFunction(_ request: BookAppointmentRequest) async -> Result<Appointment, AppError> {
        do { return .success(try await repository.bookAppointment(request)) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }
}

final class CancelAppointmentUseCase {
    private let repository: AppointmentRepository
    init(repository: AppointmentRepository) { self.repository = repository }

    func callAsFunction(id: Int) async -> Result<Appointment, AppError> {
        do { return .success(try await repository.cancelAppointment(id: id)) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }
}

final class RescheduleAppointmentUseCase {
    private let repository: AppointmentRepository
    init(repository: AppointmentRepository) { self.repository = repository }

    func callAsFunction(id: Int, date: String, time: String) async -> Result<Appointment, AppError> {
        do { return .success(try await repository.rescheduleAppointment(id: id, date: date, time: time)) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }
}

final class GetVisitHistoryUseCase {
    private let repository: AppointmentRepository
    init(repository: AppointmentRepository) { self.repository = repository }

    func callAsFunction() async -> Result<[Visit], AppError> {
        do { return .success(try await repository.getVisitHistory()) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }
}

final class GetWaitlistUseCase {
    private let repository: AppointmentRepository
    init(repository: AppointmentRepository) { self.repository = repository }

    func callAsFunction() async -> Result<[WaitlistEntry], AppError> {
        do { return .success(try await repository.getWaitlist()) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }
}

final class AddToWaitlistUseCase {
    private let repository: AppointmentRepository
    private let keychainManager: KeychainManager
    init(repository: AppointmentRepository, keychainManager: KeychainManager) {
        self.repository = repository
        self.keychainManager = keychainManager
    }

    func callAsFunction(serviceId: Int, notes: String?) async -> Result<WaitlistEntry, AppError> {
        let patientId = keychainManager.getPatientId() ?? 0
        do { return .success(try await repository.addToWaitlist(serviceId: serviceId, patientId: patientId, notes: notes)) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }
}

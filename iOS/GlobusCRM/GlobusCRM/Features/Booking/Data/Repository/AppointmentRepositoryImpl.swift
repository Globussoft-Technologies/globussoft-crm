import Foundation

final class AppointmentRepositoryImpl: AppointmentRepository {
    private let apiClient: WellnessAPIClient
    private let keychainManager: KeychainManager

    init(apiClient: WellnessAPIClient, keychainManager: KeychainManager) {
        self.apiClient = apiClient
        self.keychainManager = keychainManager
    }

    func getMyAppointments(bucket: String) async throws -> [Appointment] {
        let dto: AppointmentListResponseDTO = try await apiClient.request(.myAppointments(bucket: bucket))
        return dto.appointments.map { $0.toDomain() }
    }

    func bookAppointment(_ request: BookAppointmentRequest) async throws -> Appointment {
        let response: BookingResponseDTO = try await apiClient.requestWithBody(.bookAppointment, body: request.toDTO())
        return response.appointment.toDomain()
    }

    func cancelAppointment(id: Int) async throws -> Appointment {
        let response: BookingResponseDTO = try await apiClient.request(.cancelAppointment(id: id))
        return response.appointment.toDomain()
    }

    func rescheduleAppointment(id: Int, date: String, time: String) async throws -> Appointment {
        let body = RescheduleDTO(appointmentDate: date, appointmentTime: time)
        let response: BookingResponseDTO = try await apiClient.requestWithBody(.rescheduleAppointment(id: id), body: body)
        return response.appointment.toDomain()
    }

    func getVisitHistory() async throws -> [Visit] {
        let dtos: [VisitDTO] = try await apiClient.request(.visits)
        return dtos.map { $0.toDomain() }
    }

    func getWaitlist() async throws -> [WaitlistEntry] {
        let dtos: [WaitlistEntryDTO] = try await apiClient.request(.waitlist)
        return dtos.map { $0.toDomain() }
    }

    func addToWaitlist(serviceId: Int, patientId: Int, notes: String?) async throws -> WaitlistEntry {
        let body = AddWaitlistDTO(serviceId: serviceId, patientId: patientId, notes: notes)
        let dto: WaitlistEntryDTO = try await apiClient.requestWithBody(.addWaitlist, body: body)
        return dto.toDomain()
    }

    func getServices() async throws -> [Product] {
        let dtos: [ProductDTO] = try await apiClient.request(.services)
        return dtos.filter { $0.isActive ?? true }.map { $0.toDomain() }
    }

    func getDoctorAvailability(date: String) async throws -> [DoctorOption] {
        let dtos: [DoctorAvailabilityDTO] = try await apiClient.request(.doctors(date: date))
        let noPreference = DoctorOption(id: nil, name: "No preference")
        return [noPreference] + dtos.map { DoctorOption(id: $0.id, name: $0.name) }
    }
}

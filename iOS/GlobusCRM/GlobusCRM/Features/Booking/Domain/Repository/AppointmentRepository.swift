import Foundation

protocol AppointmentRepository {
    func getMyAppointments(bucket: String) async throws -> [Appointment]
    func bookAppointment(_ request: BookAppointmentRequest) async throws -> Appointment
    func cancelAppointment(id: Int) async throws -> Appointment
    func rescheduleAppointment(id: Int, date: String, time: String) async throws -> Appointment
    func getVisitHistory() async throws -> [Visit]
    func getWaitlist() async throws -> [WaitlistEntry]
    func addToWaitlist(serviceId: Int, patientId: Int, notes: String?) async throws -> WaitlistEntry
    func getServices() async throws -> [Product]
    func getDoctorAvailability(date: String) async throws -> [DoctorOption]
}

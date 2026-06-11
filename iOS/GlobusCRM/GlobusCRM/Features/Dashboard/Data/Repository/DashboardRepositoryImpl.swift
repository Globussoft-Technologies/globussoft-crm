import Foundation

final class DashboardRepositoryImpl: DashboardRepository {
    private let apiClient: WellnessAPIClient
    private let keychainManager: KeychainManager

    init(apiClient: WellnessAPIClient, keychainManager: KeychainManager) {
        self.apiClient = apiClient
        self.keychainManager = keychainManager
    }

    func getDashboardSummary(patientId: Int) async throws -> DashboardSummary {
        // Parallel fetch of dashboard data; individual failures degrade gracefully
        async let transactionsResult = try? apiClient.request(.myTransactions) as MyTransactionsResponseDTO
        async let appointmentsResult = try? apiClient.request(.myAppointments(bucket: "upcoming")) as AppointmentListResponseDTO
        async let membershipsResult  = try? apiClient.request(.myMemberships) as [MembershipDTO]

        let transactions = await transactionsResult
        let appointments = await appointmentsResult
        let memberships  = await membershipsResult

        // Only call loyalty when patientId is valid — mirrors Android's `?: return@async null` guard
        let loyalty: LoyaltyResponseDTO? = patientId > 0
            ? try? await apiClient.request(.loyalty(patientId: patientId)) as LoyaltyResponseDTO
            : nil

        let nextAppt = appointments?.appointments.first.map {
            AppointmentPreview(id: $0.id, doctorName: $0.doctorName,
                               serviceName: $0.serviceName,
                               appointmentDate: $0.appointmentDate, status: $0.status)
        }

        let membershipStatus: String? = memberships?.contains(where: { $0.status == "active" }) == true ? "Active" : nil

        return DashboardSummary(
            patientName: keychainManager.getPatientName() ?? "Patient",
            walletBalance: transactions?.summary.walletBalance,
            membershipStatus: membershipStatus,
            loyaltyPoints: loyalty?.balance,
            nextAppointment: nextAppt,
            currency: transactions?.currency ?? "INR"
        )
    }
}

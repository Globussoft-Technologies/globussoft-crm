import Foundation

final class GetPrescriptionsUseCase {
    private let repository: HealthRepository
    init(repository: HealthRepository) { self.repository = repository }
    func callAsFunction(patientId: String) async -> Result<[Prescription], AppError> {
        await repository.getPrescriptions(patientId: patientId)
    }
}

final class GetPrescriptionPdfUseCase {
    private let repository: HealthRepository
    init(repository: HealthRepository) { self.repository = repository }
    func callAsFunction(prescriptionId: String) async -> Result<Data, AppError> {
        await repository.getPrescriptionPdf(prescriptionId: prescriptionId)
    }
}

final class GetTreatmentPlansUseCase {
    private let repository: HealthRepository
    init(repository: HealthRepository) { self.repository = repository }
    func callAsFunction(patientId: String) async -> Result<[TreatmentPlan], AppError> {
        await repository.getTreatmentPlans(patientId: patientId)
    }
}

final class GetConsentFormsUseCase {
    private let repository: HealthRepository
    init(repository: HealthRepository) { self.repository = repository }
    func callAsFunction(patientId: String) async -> Result<[ConsentForm], AppError> {
        await repository.getConsentForms(patientId: patientId)
    }
}

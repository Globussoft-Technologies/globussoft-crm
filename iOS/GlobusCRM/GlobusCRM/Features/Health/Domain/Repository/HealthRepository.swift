import Foundation

protocol HealthRepository {
    func getPrescriptions(patientId: String) async -> Result<[Prescription], AppError>
    func getPrescriptionPdf(prescriptionId: String) async -> Result<Data, AppError>
    func getTreatmentPlans(patientId: String) async -> Result<[TreatmentPlan], AppError>
    func getConsentForms(patientId: String) async -> Result<[ConsentForm], AppError>
}

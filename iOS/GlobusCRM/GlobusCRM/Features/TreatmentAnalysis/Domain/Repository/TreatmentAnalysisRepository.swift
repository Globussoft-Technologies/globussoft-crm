import Foundation

protocol TreatmentAnalysisRepository {
    func draft(prescriptionId: String) -> TreatmentAnalysisDraft?
    func saveBeforeCapture(prescriptionId: String, imageData: Data) async -> Result<TreatmentAnalysisDraft, AppError>
    func saveAfterCapture(prescriptionId: String, imageData: Data) async -> Result<TreatmentAnalysisDraft, AppError>
    func uploadBefore(prescriptionId: String, visitId: String) async -> Result<TreatmentAnalysisDraft, AppError>
    func uploadAfter(prescriptionId: String, visitId: String) async -> Result<TreatmentAnalysisDraft, AppError>
}

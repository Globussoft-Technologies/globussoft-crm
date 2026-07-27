import Foundation

final class GetTreatmentAnalysisDraftUseCase {
    private let repository: TreatmentAnalysisRepository

    init(repository: TreatmentAnalysisRepository) {
        self.repository = repository
    }

    func callAsFunction(prescriptionId: String) -> TreatmentAnalysisDraft? {
        repository.draft(prescriptionId: prescriptionId)
    }
}

final class SaveTreatmentCaptureUseCase {
    private let repository: TreatmentAnalysisRepository

    init(repository: TreatmentAnalysisRepository) {
        self.repository = repository
    }

    func callAsFunction(prescriptionId: String,
                        imageData: Data,
                        stage: TreatmentCaptureStage) async -> Result<TreatmentAnalysisDraft, AppError> {
        switch stage {
        case .before:
            return await repository.saveBeforeCapture(prescriptionId: prescriptionId, imageData: imageData)
        case .after:
            return await repository.saveAfterCapture(prescriptionId: prescriptionId, imageData: imageData)
        }
    }
}

final class UploadTreatmentCaptureUseCase {
    private let repository: TreatmentAnalysisRepository

    init(repository: TreatmentAnalysisRepository) {
        self.repository = repository
    }

    func callAsFunction(prescriptionId: String,
                        visitId: String,
                        stage: TreatmentCaptureStage) async -> Result<TreatmentAnalysisDraft, AppError> {
        switch stage {
        case .before:
            return await repository.uploadBefore(prescriptionId: prescriptionId, visitId: visitId)
        case .after:
            return await repository.uploadAfter(prescriptionId: prescriptionId, visitId: visitId)
        }
    }
}

import Foundation

final class HealthRepositoryImpl: HealthRepository {
    private let apiClient: WellnessAPIClient
    private let keychain: KeychainManager
    // In-memory PDF cache: lives for the app session, avoids re-downloading during a session
    private let pdfCache = NSCache<NSString, NSData>()

    init(apiClient: WellnessAPIClient, keychain: KeychainManager) {
        self.apiClient = apiClient
        self.keychain = keychain
        pdfCache.countLimit = 20
        pdfCache.totalCostLimit = 50 * 1024 * 1024 // 50 MB
    }

    // Backend returns a plain array — no `data` wrapper
    func getPrescriptions(patientId: String) async -> Result<[Prescription], AppError> {
        let result: Result<[PrescriptionDTO], AppError> = await apiClient.request(
            endpoint: .getPrescriptions(patientId: patientId)
        )
        switch result {
        case .success(let items): return .success(items.map { $0.toDomain() })
        case .failure(let error): return .failure(error)
        }
    }

    func getPrescriptionPdf(prescriptionId: String) async -> Result<Data, AppError> {
        let cacheKey = NSString(string: "pdf_\(prescriptionId)")
        if let cached = pdfCache.object(forKey: cacheKey) {
            return .success(cached as Data)
        }
        let result = await apiClient.requestData(endpoint: .getPrescriptionPdf(prescriptionId: prescriptionId))
        if case .success(let data) = result {
            pdfCache.setObject(data as NSData, forKey: cacheKey, cost: data.count)
        }
        return result
    }

    // Backend returns a plain array — no `data` wrapper
    // Field names: totalSessions, completedSessions, startedAt, nextDueAt (NOT sessionsTotal etc.)
    func getTreatmentPlans(patientId: String) async -> Result<[TreatmentPlan], AppError> {
        let result: Result<[TreatmentPlanDTO], AppError> = await apiClient.request(
            endpoint: .getTreatmentPlans(patientId: patientId)
        )
        switch result {
        case .success(let items): return .success(items.map { $0.toDomain() })
        case .failure(let error): return .failure(error)
        }
    }

    // Backend returns a plain array — no `data` wrapper
    // Field names: templateName (not title), signedAt (isSigned derived), service.name (formType)
    func getConsentForms(patientId: String) async -> Result<[ConsentForm], AppError> {
        let result: Result<[ConsentFormDTO], AppError> = await apiClient.request(
            endpoint: .getConsentForms(patientId: patientId)
        )
        switch result {
        case .success(let items): return .success(items.map { $0.toDomain() })
        case .failure(let error): return .failure(error)
        }
    }
}

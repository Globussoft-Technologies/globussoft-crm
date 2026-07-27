import Foundation

final class TreatmentAnalysisRepositoryImpl: TreatmentAnalysisRepository {
    private let apiClient: WellnessAPIClient
    private let draftStore: TreatmentAnalysisDraftStore
    private let imageProcessor: TreatmentImageProcessor

    init(apiClient: WellnessAPIClient,
         draftStore: TreatmentAnalysisDraftStore = TreatmentAnalysisDraftStore(),
         imageProcessor: TreatmentImageProcessor = TreatmentImageProcessor()) {
        self.apiClient = apiClient
        self.draftStore = draftStore
        self.imageProcessor = imageProcessor
    }

    func draft(prescriptionId: String) -> TreatmentAnalysisDraft? {
        draftStore.load(prescriptionId: prescriptionId)
    }

    func saveBeforeCapture(prescriptionId: String, imageData: Data) async -> Result<TreatmentAnalysisDraft, AppError> {
        await saveCapture(prescriptionId: prescriptionId, imageData: imageData, stage: .before)
    }

    func saveAfterCapture(prescriptionId: String, imageData: Data) async -> Result<TreatmentAnalysisDraft, AppError> {
        await saveCapture(prescriptionId: prescriptionId, imageData: imageData, stage: .after)
    }

    func uploadBefore(prescriptionId: String, visitId: String) async -> Result<TreatmentAnalysisDraft, AppError> {
        guard var draft = draftStore.load(prescriptionId: prescriptionId) else {
            return .failure(.network("Capture a before image first."))
        }
        guard let localPath = draft.beforeLocalPath else {
            return .failure(.network("Capture a before image first."))
        }
        return await upload(draft: &draft, localPath: localPath, visitId: visitId, stage: .before)
    }

    func uploadAfter(prescriptionId: String, visitId: String) async -> Result<TreatmentAnalysisDraft, AppError> {
        guard var draft = draftStore.load(prescriptionId: prescriptionId) else {
            return .failure(.network("Capture a before image first."))
        }
        guard let localPath = draft.afterLocalPath else {
            return .failure(.network("Capture an after image first."))
        }
        return await upload(draft: &draft, localPath: localPath, visitId: visitId, stage: .after)
    }

    private func saveCapture(prescriptionId: String,
                             imageData: Data,
                             stage: TreatmentCaptureStage) async -> Result<TreatmentAnalysisDraft, AppError> {
        do {
            let savedURL = try imageProcessor.compressToPrivateFile(
                imageData: imageData,
                prescriptionId: prescriptionId,
                stage: stage
            )
            let now = Date().timeIntervalSince1970
            var draft = draftStore.load(prescriptionId: prescriptionId)
                ?? TreatmentAnalysisDraft(
                    prescriptionId: prescriptionId,
                    analysisId: nil,
                    beforeLocalPath: nil,
                    beforeRemoteUrl: nil,
                    beforeCapturedAt: nil,
                    afterLocalPath: nil,
                    afterRemoteUrl: nil,
                    afterCapturedAt: nil,
                    status: .draft,
                    updatedAt: now
                )

            switch stage {
            case .before:
                draft.beforeLocalPath = savedURL.path
                draft.beforeCapturedAt = now
                draft.afterLocalPath = nil
                draft.afterRemoteUrl = nil
                draft.afterCapturedAt = nil
                draft.status = .beforeCaptured
            case .after:
                draft.afterLocalPath = savedURL.path
                draft.afterCapturedAt = now
                draft.status = .afterCaptured
            }

            draft.updatedAt = now
            try draftStore.save(draft)
            return .success(draft)
        } catch let error as AppError {
            return .failure(error)
        } catch {
            return .failure(.network(error.localizedDescription))
        }
    }

    private func upload(draft: inout TreatmentAnalysisDraft,
                        localPath: String,
                        visitId: String,
                        stage: TreatmentCaptureStage) async -> Result<TreatmentAnalysisDraft, AppError> {
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: localPath))
            let result = await apiClient.uploadMultipart(
                endpoint: .uploadVisitTreatmentPhoto(visitId: visitId),
                data: data,
                fieldName: "photos",
                fileName: URL(fileURLWithPath: localPath).lastPathComponent,
                mimeType: "image/jpeg",
                fields: ["kind": stage.rawValue]
            )

            switch result {
            case .success:
                let now = Date().timeIntervalSince1970
                switch stage {
                case .before:
                    draft.beforeRemoteUrl = draft.beforeRemoteUrl ?? ""
                    draft.status = .beforeUploaded
                case .after:
                    draft.afterRemoteUrl = draft.afterRemoteUrl ?? ""
                    draft.status = .submittedForReview
                }
                draft.updatedAt = now
                try draftStore.save(draft)
                return .success(draft)
            case .failure(let error):
                return .failure(error)
            }
        } catch {
            return .failure(.network(error.localizedDescription))
        }
    }
}

final class TreatmentAnalysisDraftStore {
    private let fileManager: FileManager
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    func load(prescriptionId: String) -> TreatmentAnalysisDraft? {
        let url = draftURL(prescriptionId: prescriptionId)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(TreatmentAnalysisDraft.self, from: data)
    }

    func save(_ draft: TreatmentAnalysisDraft) throws {
        let directory = try draftsDirectory()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try encoder.encode(draft)
        try data.write(to: draftURL(prescriptionId: draft.prescriptionId), options: [.atomic])
    }

    private func draftURL(prescriptionId: String) -> URL {
        (try? draftsDirectory())?
            .appendingPathComponent("prescription_\(safeFilePart(prescriptionId)).json")
        ?? URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("prescription_\(safeFilePart(prescriptionId)).json")
    }

    private func draftsDirectory() throws -> URL {
        let base = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return base
            .appendingPathComponent("GlobusCRM", isDirectory: true)
            .appendingPathComponent("treatment_analysis", isDirectory: true)
            .appendingPathComponent("drafts", isDirectory: true)
    }

    private func safeFilePart(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        return value.unicodeScalars
            .map { allowed.contains($0) ? Character($0) : "_" }
            .reduce(into: "") { $0.append($1) }
    }
}

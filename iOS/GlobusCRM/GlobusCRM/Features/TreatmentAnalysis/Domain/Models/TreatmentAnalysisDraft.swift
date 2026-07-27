import Foundation

struct TreatmentAnalysisDraft: Codable, Equatable {
    let prescriptionId: String
    var analysisId: String?
    var beforeLocalPath: String?
    var beforeRemoteUrl: String?
    var beforeCapturedAt: TimeInterval?
    var afterLocalPath: String?
    var afterRemoteUrl: String?
    var afterCapturedAt: TimeInterval?
    var status: TreatmentAnalysisStatus
    var updatedAt: TimeInterval

    var hasBefore: Bool {
        !(beforeRemoteUrl ?? "").isEmpty || !(beforeLocalPath ?? "").isEmpty
    }

    var hasUploadedBefore: Bool {
        status == .beforeUploaded ||
        status == .afterCaptured ||
        status == .submittedForReview ||
        !(beforeRemoteUrl ?? "").isEmpty
    }

    var hasSubmittedAfter: Bool {
        status == .submittedForReview || !(afterRemoteUrl ?? "").isEmpty
    }
}

enum TreatmentAnalysisStatus: String, Codable {
    case draft
    case beforeCaptured = "before_captured"
    case beforeUploaded = "before_uploaded"
    case afterCaptured = "after_captured"
    case submittedForReview = "submitted_for_review"
}

enum TreatmentCaptureStage: String, Codable {
    case before
    case after

    var title: String {
        switch self {
        case .before: return "before"
        case .after:  return "after"
        }
    }
}

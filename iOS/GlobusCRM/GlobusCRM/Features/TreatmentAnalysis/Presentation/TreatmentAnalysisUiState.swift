import Foundation
import UIKit

struct TreatmentAnalysisUiState {
    let prescriptionId: String
    let visitId: String?
    var isLoading: Bool = true
    var isUploading: Bool = false
    var hasCameraPermission: Bool = false
    var showCameraPicker: Bool = false
    var showCameraPermissionAlert: Bool = false
    var draft: TreatmentAnalysisDraft?
    var captureStage: TreatmentCaptureStage = .before
    var selectedImageData: Data?
    var selectedImagePreview: UIImage?
    var message: String?
    var error: String?
}

enum TreatmentAnalysisUiEvent {
    case load
    case requestCamera
    case dismissCamera
    case cameraPermissionAlertShown
    case imageSelected(Data)
    case retake
    case confirmImage
    case retryUpload
    case dismissMessage
}

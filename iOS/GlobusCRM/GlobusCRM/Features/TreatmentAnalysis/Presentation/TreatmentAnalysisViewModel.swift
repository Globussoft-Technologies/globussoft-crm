import AVFoundation
import Combine
import Foundation
import UIKit

@MainActor
final class TreatmentAnalysisViewModel: ObservableObject {
    @Published var uiState: TreatmentAnalysisUiState

    private let getDraftUseCase: GetTreatmentAnalysisDraftUseCase
    private let saveCaptureUseCase: SaveTreatmentCaptureUseCase
    private let uploadCaptureUseCase: UploadTreatmentCaptureUseCase
    private let qualityChecker: TreatmentImageQualityChecker

    init(prescriptionId: String,
         visitId: String?,
         getDraftUseCase: GetTreatmentAnalysisDraftUseCase,
         saveCaptureUseCase: SaveTreatmentCaptureUseCase,
         uploadCaptureUseCase: UploadTreatmentCaptureUseCase,
         qualityChecker: TreatmentImageQualityChecker) {
        self.uiState = TreatmentAnalysisUiState(prescriptionId: prescriptionId, visitId: visitId)
        self.getDraftUseCase = getDraftUseCase
        self.saveCaptureUseCase = saveCaptureUseCase
        self.uploadCaptureUseCase = uploadCaptureUseCase
        self.qualityChecker = qualityChecker
    }

    func onEvent(_ event: TreatmentAnalysisUiEvent) {
        switch event {
        case .load:
            load()
        case .requestCamera:
            requestCamera()
        case .dismissCamera:
            uiState.showCameraPicker = false
        case .cameraPermissionAlertShown:
            uiState.showCameraPermissionAlert = false
        case .imageSelected(let data):
            handleImageSelected(data)
        case .retake:
            uiState.selectedImageData = nil
            uiState.selectedImagePreview = nil
            uiState.error = nil
        case .confirmImage:
            Task { await confirmImage() }
        case .retryUpload:
            Task { await retryUpload() }
        case .dismissMessage:
            uiState.message = nil
            uiState.error = nil
        }
    }

    private func load() {
        uiState.isLoading = false
        uiState.hasCameraPermission = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
        applyDraft(getDraftUseCase(prescriptionId: uiState.prescriptionId))
    }

    private func requestCamera() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            uiState.error = "Camera is not available on this device."
            return
        }

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            uiState.hasCameraPermission = true
            uiState.showCameraPicker = true
        case .notDetermined:
            Task {
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                uiState.hasCameraPermission = granted
                uiState.showCameraPicker = granted
                uiState.showCameraPermissionAlert = !granted
            }
        case .denied, .restricted:
            uiState.hasCameraPermission = false
            uiState.showCameraPermissionAlert = true
        @unknown default:
            uiState.hasCameraPermission = false
            uiState.showCameraPermissionAlert = true
        }
    }

    private func handleImageSelected(_ data: Data) {
        let quality = qualityChecker.check(imageData: data)
        guard quality.isAcceptable, let image = UIImage(data: data) else {
            uiState.selectedImageData = nil
            uiState.selectedImagePreview = nil
            uiState.error = quality.message ?? "Image could not be read. Please retake it."
            return
        }
        uiState.selectedImageData = data
        uiState.selectedImagePreview = image
        uiState.error = nil
        uiState.message = nil
    }

    private func confirmImage() async {
        guard let imageData = uiState.selectedImageData else { return }
        let stage = uiState.captureStage

        uiState.isUploading = true
        uiState.error = nil
        uiState.message = nil

        let saveResult = await saveCaptureUseCase(
            prescriptionId: uiState.prescriptionId,
            imageData: imageData,
            stage: stage
        )

        switch saveResult {
        case .success(let draft):
            applyDraft(draft)
        case .failure(let error):
            uiState.isUploading = false
            uiState.error = error.localizedDescription
            return
        }

        guard let visitId = uiState.visitId, !visitId.isEmpty else {
            uiState.isUploading = false
            uiState.selectedImageData = nil
            uiState.selectedImagePreview = nil
            uiState.error = "This prescription does not have visit data, so photos cannot be uploaded."
            return
        }

        let uploadResult = await uploadCaptureUseCase(
            prescriptionId: uiState.prescriptionId,
            visitId: visitId,
            stage: stage
        )

        uiState.isUploading = false
        uiState.selectedImageData = nil
        uiState.selectedImagePreview = nil

        switch uploadResult {
        case .success(let draft):
            applyDraft(draft)
            uiState.message = stage == .before
                ? "Before image saved. Capture after image later."
                : "Images submitted for review."
        case .failure(let error):
            uiState.error = error.localizedDescription
        }
    }

    private func retryUpload() async {
        guard let draft = uiState.draft else { return }
        guard let visitId = uiState.visitId, !visitId.isEmpty else {
            uiState.error = "This prescription does not have visit data, so photos cannot be uploaded."
            return
        }

        let stage: TreatmentCaptureStage
        switch draft.status {
        case .beforeCaptured:
            stage = .before
        case .afterCaptured:
            stage = .after
        default:
            return
        }

        uiState.isUploading = true
        uiState.error = nil
        uiState.message = nil

        let result = await uploadCaptureUseCase(
            prescriptionId: uiState.prescriptionId,
            visitId: visitId,
            stage: stage
        )

        uiState.isUploading = false
        switch result {
        case .success(let draft):
            applyDraft(draft)
            uiState.message = stage == .after
                ? "Images submitted for review."
                : "Before image saved. Capture after image later."
        case .failure(let error):
            uiState.error = error.localizedDescription
        }
    }

    private func applyDraft(_ draft: TreatmentAnalysisDraft?) {
        uiState.draft = draft
        uiState.captureStage = (draft?.hasUploadedBefore == true || draft?.hasSubmittedAfter == true) ? .after : .before
    }
}

import AVFoundation
import PhotosUI
import SwiftUI
import UIKit

struct TreatmentAnalysisView: View {
    @StateObject var viewModel: TreatmentAnalysisViewModel
    @State private var selectedPhotoItem: PhotosPickerItem?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Layout.sectionSpacing) {
                header

                if let message = viewModel.uiState.message {
                    TreatmentAnalysisBanner(message: message, icon: "checkmark.circle.fill", color: .wellnessTeal) {
                        viewModel.onEvent(.dismissMessage)
                    }
                }

                if let error = viewModel.uiState.error {
                    TreatmentAnalysisBanner(message: error, icon: "exclamationmark.triangle.fill", color: .wellnessError) {
                        viewModel.onEvent(.dismissMessage)
                    }
                }

                statusPanel
                guidancePanel
                contentPanel
                retryPanel
            }
            .padding(Layout.pagePadding)
            .padding(.bottom, WellnessSpacing.xl)
        }
        .background(Color.wellnessBackground)
        .navigationTitle("Before/After Scan")
        .navigationBarTitleDisplayMode(.inline)
        .task { viewModel.onEvent(.load) }
        .sheet(isPresented: Binding(
            get: { viewModel.uiState.showCameraPicker },
            set: { if !$0 { viewModel.onEvent(.dismissCamera) } }
        )) {
            CameraImagePicker { data in
                viewModel.onEvent(.imageSelected(data))
            }
            .ignoresSafeArea()
        }
        .alert("Camera Access Needed", isPresented: Binding(
            get: { viewModel.uiState.showCameraPermissionAlert },
            set: { if !$0 { viewModel.onEvent(.cameraPermissionAlertShown) } }
        )) {
            Button("OK", role: .cancel) { viewModel.onEvent(.cameraPermissionAlertShown) }
        } message: {
            Text("Allow camera access in Settings to capture treatment images.")
        }
        .onChange(of: selectedPhotoItem) { item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    viewModel.onEvent(.imageSelected(data))
                }
                selectedPhotoItem = nil
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
            Text("Prescription #\(viewModel.uiState.prescriptionId)")
                .font(.wellnessTitle)
                .fontWeight(.semibold)
                .foregroundColor(.wellnessOnSurface)
            if let visitId = viewModel.uiState.visitId {
                Text("Visit #\(visitId)")
                    .font(.wellnessCaption)
                    .foregroundColor(.wellnessMuted)
            }
        }
    }

    private var statusPanel: some View {
        WellnessCard {
            VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                HStack(spacing: WellnessSpacing.sm) {
                    Image(systemName: statusIcon)
                        .font(.system(size: IconSize.small, weight: .semibold))
                        .foregroundColor(.wellnessTeal)
                    Text(statusTitle)
                        .font(.wellnessSubheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(.wellnessOnSurface)
                }
                Text("You will explicitly confirm each upload. Medical photos are not uploaded in the background.")
                    .font(.wellnessCaption)
                    .foregroundColor(.wellnessMuted)
            }
            .padding(Layout.cardPadding)
        }
    }

    private var statusTitle: String {
        guard let draft = viewModel.uiState.draft else {
            return "Capture the before image first."
        }
        if draft.hasSubmittedAfter {
            return "Images submitted for review."
        }
        if draft.hasUploadedBefore {
            return "Before image saved. Capture after image later."
        }
        switch draft.status {
        case .beforeCaptured:
            return "Before image captured. Upload is pending."
        case .afterCaptured:
            return "After image captured. Upload is pending."
        default:
            return "Capture the before image first."
        }
    }

    private var statusIcon: String {
        viewModel.uiState.draft?.hasSubmittedAfter == true ? "checkmark.seal.fill" : "camera.metering.center.weighted"
    }

    private var guidancePanel: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
            SectionLabel(title: "Photo Guidance")
            VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                GuidanceRow(text: "Align the same treatment area.")
                GuidanceRow(text: "Use good lighting and avoid glare.")
                GuidanceRow(text: "Keep the camera steady before capture.")
            }
        }
    }

    @ViewBuilder
    private var contentPanel: some View {
        if viewModel.uiState.isLoading {
            LoadingView()
                .frame(maxWidth: .infinity, minHeight: 220)
        } else if let image = viewModel.uiState.selectedImagePreview {
            capturedPreview(image)
        } else if viewModel.uiState.draft?.hasSubmittedAfter == true {
            reviewPendingPanel
        } else {
            capturePanel
        }
    }

    private func capturedPreview(_ image: UIImage) -> some View {
        VStack(spacing: WellnessSpacing.md) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(maxWidth: .infinity)
                .aspectRatio(4.0 / 3.0, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
                .clipped()

            HStack(spacing: WellnessSpacing.sm) {
                WellnessButton("Retake", style: .secondary) {
                    viewModel.onEvent(.retake)
                }
                WellnessButton("Use photo", isLoading: viewModel.uiState.isUploading) {
                    viewModel.onEvent(.confirmImage)
                }
            }
        }
    }

    private var capturePanel: some View {
        VStack(spacing: WellnessSpacing.md) {
            TreatmentCapturePrompt(stage: viewModel.uiState.captureStage)

            TreatmentAnalysisActionButton(icon: "camera.fill",
                                          title: "Capture \(viewModel.uiState.captureStage.title) photo",
                                          isPrimary: true,
                                          isLoading: viewModel.uiState.isUploading) {
                viewModel.onEvent(.requestCamera)
            }

            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                HStack(spacing: WellnessSpacing.sm) {
                    Image(systemName: "photo.on.rectangle")
                    Text("Choose from Photos")
                        .font(.wellnessCallout)
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: Layout.minTapTarget)
                .foregroundColor(.wellnessTeal)
                .background(Color.clear)
                .overlay(
                    RoundedRectangle(cornerRadius: WellnessRadius.medium)
                        .stroke(Color.wellnessTeal.opacity(0.6), lineWidth: 1.5)
                )
                .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
            }
            .disabled(viewModel.uiState.isUploading)
        }
    }

    private var reviewPendingPanel: some View {
        WellnessCard {
            HStack(spacing: WellnessSpacing.md) {
                Image(systemName: "hourglass.circle.fill")
                    .font(.system(size: IconSize.medium))
                    .foregroundColor(.wellnessGold)
                Text("Your before and after images are with the clinic for review.")
                    .font(.wellnessBody)
                    .foregroundColor(.wellnessOnSurface)
                Spacer(minLength: 0)
            }
            .padding(Layout.cardPadding)
        }
    }

    @ViewBuilder
    private var retryPanel: some View {
        if canRetry {
            TreatmentAnalysisActionButton(icon: "arrow.clockwise",
                                          title: "Retry upload",
                                          isPrimary: false,
                                          isLoading: viewModel.uiState.isUploading) {
                viewModel.onEvent(.retryUpload)
            }
        }
    }

    private var canRetry: Bool {
        guard let status = viewModel.uiState.draft?.status else { return false }
        return status == .beforeCaptured || status == .afterCaptured
    }
}

private struct TreatmentCapturePrompt: View {
    let stage: TreatmentCaptureStage

    var body: some View {
        WellnessCard {
            HStack(spacing: WellnessSpacing.md) {
                ZStack {
                    Circle()
                        .fill(Color.wellnessBlush.opacity(0.12))
                        .frame(width: 48, height: 48)
                    Image(systemName: stage == .before ? "1.circle.fill" : "2.circle.fill")
                        .font(.system(size: IconSize.small))
                        .foregroundColor(.wellnessBlush)
                }
                VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                    Text(stage == .before ? "Before photo" : "After photo")
                        .font(.wellnessSubheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(.wellnessOnSurface)
                    Text(stage == .before ? "Start with the untreated area." : "Capture the matching follow-up view.")
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessMuted)
                }
                Spacer(minLength: 0)
            }
            .padding(Layout.cardPadding)
        }
    }
}

private struct GuidanceRow: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: WellnessSpacing.sm) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: IconSize.badge))
                .foregroundColor(.wellnessTeal)
            Text(text)
                .font(.wellnessCaption)
                .foregroundColor(.wellnessMuted)
            Spacer(minLength: 0)
        }
    }
}

private struct TreatmentAnalysisBanner: View {
    let message: String
    let icon: String
    let color: Color
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: WellnessSpacing.sm) {
            Image(systemName: icon)
                .font(.system(size: IconSize.badge))
                .foregroundColor(color)
            Text(message)
                .font(.wellnessCaption)
                .foregroundColor(color)
                .lineLimit(3)
            Spacer(minLength: 0)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(color)
                    .frame(width: 28, height: 28)
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, Layout.cardPadding)
        .padding(.vertical, WellnessSpacing.sm)
        .background(color.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
    }
}

private struct TreatmentAnalysisActionButton: View {
    let icon: String
    let title: String
    let isPrimary: Bool
    let isLoading: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: WellnessSpacing.sm) {
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .tint(isPrimary ? .white : .wellnessTeal)
                } else {
                    Image(systemName: icon)
                        .font(.system(size: IconSize.small, weight: .semibold))
                }
                Text(title)
                    .font(.wellnessCallout)
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: Layout.minTapTarget)
            .foregroundColor(isPrimary ? .white : .wellnessTeal)
            .background(isPrimary ? Color.wellnessTeal : Color.clear)
            .overlay(
                RoundedRectangle(cornerRadius: WellnessRadius.medium)
                    .stroke(isPrimary ? Color.clear : Color.wellnessTeal.opacity(0.6), lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
            .opacity(isLoading ? 0.5 : 1)
        }
        .disabled(isLoading)
    }
}

private struct CameraImagePicker: UIViewControllerRepresentable {
    let onImage: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        private let parent: CameraImagePicker

        init(parent: CameraImagePicker) {
            self.parent = parent
        }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage,
               let data = image.jpegData(compressionQuality: 0.92) {
                parent.onImage(data)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

import SwiftUI
import PDFKit

struct PrescriptionPDFScreen: View {
    let prescriptionId: String
    let getPrescriptionPdfUseCase: GetPrescriptionPdfUseCase
    @State private var state: PrescriptionPDFLoadState = .loading

    var body: some View {
        Group {
            switch state {
            case .loading:
                LoadingView()
            case .loaded(let data):
                PrescriptionPDFView(pdfData: data)
            case .error(let message):
                ErrorStateView(message: message) {
                    Task { await load(force: true) }
                }
                .padding(Layout.pagePadding)
            }
        }
        .navigationTitle("Prescription")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: prescriptionId) {
            await load(force: false)
        }
    }

    private func load(force: Bool) async {
        if case .loaded = state, !force { return }
        state = .loading
        let result = await getPrescriptionPdfUseCase(prescriptionId: prescriptionId)
        switch result {
        case .success(let data):
            if PDFDocument(data: data) == nil {
                state = .error("Prescription PDF is not available yet. Please try again later.")
            } else {
                state = .loaded(data)
            }
        case .failure(let error):
            state = .error(error.localizedDescription)
        }
    }
}

private enum PrescriptionPDFLoadState {
    case loading
    case loaded(Data)
    case error(String)
}

struct PrescriptionPDFView: View {
    let pdfData: Data

    var body: some View {
        PDFKitView(data: pdfData)
            .ignoresSafeArea(edges: .bottom)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    ShareLink(item: pdfData, preview: SharePreview("Prescription.pdf"))
                }
            }
    }
}

struct PDFKitView: UIViewRepresentable {
    let data: Data

    func makeUIView(context: Context) -> PDFView {
        let pdfView = PDFView()
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        pdfView.document = PDFDocument(data: data)
        return pdfView
    }

    func updateUIView(_ uiView: PDFView, context: Context) {
        uiView.document = PDFDocument(data: data)
    }
}

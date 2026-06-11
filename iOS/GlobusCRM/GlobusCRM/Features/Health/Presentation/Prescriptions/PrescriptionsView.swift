import SwiftUI
import Combine

struct PrescriptionsView: View {
    @StateObject var viewModel: PrescriptionsViewModel
    @EnvironmentObject var appState: AppState
    @State private var pdfData: Data? = nil
    @State private var showPdf = false

    var body: some View {
        Group {
            if !viewModel.uiState.hasLoaded {
                SkeletonListView(count: 5, cardHeight: 76)
            } else if let error = viewModel.uiState.error {
                ErrorStateView(message: error) {
                    viewModel.onEvent(.load)
                }
            } else if viewModel.uiState.prescriptions.isEmpty {
                EmptyStateView(
                    icon: "cross.case",
                    title: "No Prescriptions",
                    subtitle: "Your prescriptions will appear here after visits."
                )
            } else {
                List(viewModel.uiState.prescriptions) { prescription in
                    PrescriptionRowView(
                        prescription: prescription,
                        isLoadingPdf: viewModel.uiState.loadingPdfId == prescription.id
                    ) {
                        viewModel.onEvent(.requestViewPdf(prescription))
                    }
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(
                        top: WellnessSpacing.xs,
                        leading: Layout.pagePadding,
                        bottom: WellnessSpacing.xs,
                        trailing: Layout.pagePadding
                    ))
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(Color.wellnessBackground)
                .refreshable { viewModel.onEvent(.load) }
            }
        }
        .navigationTitle("Prescriptions")
        .navigationBarTitleDisplayMode(.large)
        .task { viewModel.onEvent(.load) }
        .sheet(isPresented: $showPdf) {
            if let data = pdfData {
                PrescriptionPDFView(pdfData: data)
            }
        }
        .alert("Open prescription PDF?", isPresented: $viewModel.uiState.showPdfConfirm) {
            Button("Open") { viewModel.onEvent(.confirmViewPdf) }
            Button("Cancel", role: .cancel) { viewModel.onEvent(.dismissPdfConfirm) }
        } message: {
            Text("This will download the document to view it in the app.")
        }
        .onReceive(viewModel.navSignal) { signal in
            switch signal {
            case .showPdf(let data):
                pdfData = data
                showPdf = true
            }
        }
    }
}

struct PrescriptionRowView: View {
    let prescription: Prescription
    var isLoadingPdf: Bool = false
    let onViewPdf: () -> Void

    var body: some View {
        WellnessCard {
            VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                HStack {
                    VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                        Text(prescription.serviceName)
                            .font(.wellnessSubheadline)
                            .foregroundColor(.wellnessOnSurface)
                        Text("Dr. \(prescription.doctorName)")
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessMuted)
                    }
                    Spacer()
                    Text(DateUtil.formatDate(iso: prescription.visitDate))
                        .font(.wellnessCaption2)
                        .foregroundColor(.wellnessMuted)
                }

                if !prescription.drugs.isEmpty {
                    Text("\(prescription.drugs.count) medication\(prescription.drugs.count == 1 ? "" : "s")")
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessMuted)
                }

                Button(action: onViewPdf) {
                    HStack(spacing: WellnessSpacing.xs) {
                        if isLoadingPdf {
                            ProgressView()
                                .scaleEffect(0.8)
                                .tint(.wellnessTeal)
                        } else {
                            Image(systemName: "doc.richtext")
                                .font(.system(size: IconSize.small))
                                .accessibilityHidden(true)
                        }
                        Text(isLoadingPdf ? "Loading…" : "View PDF")
                            .font(.wellnessCallout)
                    }
                    .foregroundColor(.wellnessTeal)
                }
                .disabled(isLoadingPdf)
                .accessibilityLabel(isLoadingPdf ? "Loading prescription PDF" : "View prescription PDF")
            }
            .padding(Layout.cardPadding)
        }
    }
}

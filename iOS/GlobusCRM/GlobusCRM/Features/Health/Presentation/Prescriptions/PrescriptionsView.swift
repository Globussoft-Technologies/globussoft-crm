import SwiftUI
import Combine

struct PrescriptionsView: View {
    @StateObject var viewModel: PrescriptionsViewModel
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var router: AppRouter
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
                        isLoadingPdf: viewModel.uiState.loadingPdfId == prescription.id,
                        reminderEnabled: viewModel.uiState.reminderEnabledIds.contains(prescription.id),
                        reminderInProgress: viewModel.uiState.reminderActionInProgressId == prescription.id
                    ) {
                        viewModel.onEvent(.requestViewPdf(prescription))
                    } onTreatmentScan: {
                        router.navigate(to: .treatmentAnalysis(
                            prescriptionId: prescription.id,
                            visitId: prescription.visitId
                        ))
                    } onReminderChange: { enabled in
                        viewModel.onEvent(.toggleReminder(prescription, enabled))
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
        .alert("Medication reminders", isPresented: Binding(
            get: { viewModel.uiState.reminderMessage != nil },
            set: { if !$0 { viewModel.onEvent(.dismissReminderMessage) } }
        )) {
            Button("OK", role: .cancel) { viewModel.onEvent(.dismissReminderMessage) }
        } message: {
            Text(viewModel.uiState.reminderMessage ?? "")
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
    var reminderEnabled: Bool = false
    var reminderInProgress: Bool = false
    let onViewPdf: () -> Void
    let onTreatmentScan: () -> Void
    let onReminderChange: (Bool) -> Void

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
                    HStack(spacing: WellnessSpacing.sm) {
                        Text("\(prescription.drugs.count) medication\(prescription.drugs.count == 1 ? "" : "s")")
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessMuted)

                        Spacer(minLength: 0)

                        Toggle("Reminder", isOn: Binding(
                            get: { reminderEnabled },
                            set: { onReminderChange($0) }
                        ))
                        .font(.wellnessCaption)
                        .toggleStyle(SwitchToggleStyle(tint: .wellnessTeal))
                        .disabled(reminderInProgress)
                    }
                }

                HStack(spacing: WellnessSpacing.sm) {
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
                            Text(isLoadingPdf ? "Loading..." : "View PDF")
                                .font(.wellnessCallout)
                        }
                        .frame(maxWidth: .infinity)
                        .foregroundColor(.wellnessTeal)
                    }
                    .disabled(isLoadingPdf)
                    .accessibilityLabel(isLoadingPdf ? "Loading prescription PDF" : "View prescription PDF")

                    Button(action: onTreatmentScan) {
                        HStack(spacing: WellnessSpacing.xs) {
                            Image(systemName: "camera.fill")
                                .font(.system(size: IconSize.small))
                                .accessibilityHidden(true)
                            Text("Before/After")
                                .font(.wellnessCallout)
                        }
                        .frame(maxWidth: .infinity)
                        .foregroundColor(.wellnessBlush)
                    }
                    .accessibilityLabel("Before and after scan")
                }
            }
            .padding(Layout.cardPadding)
        }
    }
}

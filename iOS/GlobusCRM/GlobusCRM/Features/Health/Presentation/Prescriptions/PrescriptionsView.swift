import SwiftUI
import Combine

struct PrescriptionsView: View {
    @StateObject var viewModel: PrescriptionsViewModel
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var router: AppRouter

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
            case .openPdf(let prescriptionId):
                router.navigate(to: .prescriptionPdf(prescriptionId: prescriptionId))
            }
        }
    }
}

struct PrescriptionRowView: View {
    let prescription: Prescription
    var reminderEnabled: Bool = false
    var reminderInProgress: Bool = false
    let onViewPdf: () -> Void
    let onTreatmentScan: () -> Void
    let onReminderChange: (Bool) -> Void

    private var serviceTitle: String {
        prescription.serviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "Prescription"
            : prescription.serviceName
    }

    private var doctorLabel: String? {
        let value = prescription.doctorName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        return value.lowercased().hasPrefix("dr.") ? value : "Dr. \(value)"
    }

    private var instructionsText: String? {
        prescription.instructions?.strippingHTML.nonBlank
    }

    var body: some View {
        WellnessCard {
            VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                HStack {
                    VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                        Text(serviceTitle)
                            .font(.wellnessSubheadline)
                            .foregroundColor(.wellnessOnSurface)
                        if let doctorLabel {
                            Text(doctorLabel)
                                .font(.wellnessCaption)
                                .foregroundColor(.wellnessMuted)
                        }
                    }
                    Spacer()
                    Text(DateUtil.formatDate(iso: prescription.visitDate))
                        .font(.wellnessCaption2)
                        .foregroundColor(.wellnessMuted)
                }

                if let instructionsText {
                    PrescriptionInstructionsView(instructions: instructionsText)
                }

                if !prescription.drugs.isEmpty {
                    PrescriptionMedicationSummaryView(
                        drugs: prescription.drugs,
                        reminderEnabled: reminderEnabled,
                        reminderInProgress: reminderInProgress,
                        onReminderChange: onReminderChange
                    )
                }

                HStack(spacing: WellnessSpacing.sm) {
                    Button(action: onViewPdf) {
                        HStack(spacing: WellnessSpacing.xs) {
                            Image(systemName: "doc.richtext")
                                .font(.system(size: IconSize.small))
                                .accessibilityHidden(true)
                            Text("View PDF")
                                .font(.wellnessCallout)
                        }
                        .frame(maxWidth: .infinity)
                        .foregroundColor(.wellnessTeal)
                    }
                    .accessibilityLabel("View prescription PDF")

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

private struct PrescriptionInstructionsView: View {
    let instructions: String
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
            Text("Instructions")
                .font(.wellnessCaption2)
                .fontWeight(.semibold)
                .foregroundColor(.wellnessMuted)
            Text(instructions)
                .font(.wellnessCaption)
                .foregroundColor(.wellnessOnSurface)
                .lineLimit(isExpanded ? nil : 2)

            if instructions.count > 90 {
                Button(isExpanded ? "Show less" : "Show more") {
                    withAnimation(AppAnimation.easeOut) { isExpanded.toggle() }
                }
                .font(.wellnessCaption2)
                .foregroundColor(.wellnessTeal)
            }
        }
        .padding(WellnessSpacing.sm)
        .background(Color.wellnessTeal.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
    }
}

private struct PrescriptionMedicationSummaryView: View {
    let drugs: [Drug]
    let reminderEnabled: Bool
    let reminderInProgress: Bool
    let onReminderChange: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
            HStack(spacing: WellnessSpacing.sm) {
                Text("\(drugs.count) medication\(drugs.count == 1 ? "" : "s")")
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

            ForEach(drugs.prefix(2)) { drug in
                PrescriptionDrugLineView(drug: drug)
            }
        }
    }
}

private struct PrescriptionDrugLineView: View {
    let drug: Drug

    var body: some View {
        let detail = [drug.dosage, drug.frequency, drug.duration]
            .compactMap { $0?.nonBlank }
            .joined(separator: " • ")

        VStack(alignment: .leading, spacing: 2) {
            Text(drug.name)
                .font(.wellnessCaption)
                .fontWeight(.medium)
                .foregroundColor(.wellnessOnSurface)
                .lineLimit(1)
            if !detail.isEmpty {
                Text(detail)
                    .font(.wellnessCaption2)
                    .foregroundColor(.wellnessMuted)
                    .lineLimit(1)
            }
        }
    }
}

private extension String {
    var nonBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.lowercased() == "null" ? nil : trimmed
    }
}

import SwiftUI

struct Step4ConfirmView: View {
    @ObservedObject var viewModel: BookAppointmentViewModel
    @FocusState private var reasonFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: WellnessSpacing.xl) {
                    confirmationCard
                    reasonField
                }
                .padding(Layout.pagePadding)
            }

            VStack {
                if let error = viewModel.uiState.error {
                    Text(error)
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessError)
                        .padding(.horizontal, Layout.pagePadding)
                        .padding(.top, WellnessSpacing.sm)
                }
                Divider()
                WellnessButton("Confirm Booking", isLoading: viewModel.uiState.isBooking) {
                    viewModel.onEvent(.confirm)
                }
                .padding(.horizontal, Layout.pagePadding)
                .padding(.vertical, WellnessSpacing.md)
            }
            .background(Color.wellnessBackground)
        }
    }

    private var confirmationCard: some View {
        WellnessCard {
            VStack(alignment: .leading, spacing: 0) {
                confirmRow(label: "Service", value: viewModel.uiState.selectedService?.name ?? "—")
                Divider().padding(.leading, Layout.cardPadding)
                confirmRow(label: "Doctor", value: viewModel.uiState.selectedDoctorName ?? "No preference")
                Divider().padding(.leading, Layout.cardPadding)
                confirmRow(label: "Date", value: displayDate)
                Divider().padding(.leading, Layout.cardPadding)
                confirmRow(label: "Time", value: displayTime)
            }
        }
    }

    private var displayDate: String {
        let f = DateFormatter()
        f.dateStyle = .long
        f.timeStyle = .none
        return f.string(from: viewModel.uiState.selectedDate)
    }

    private var displayTime: String {
        let input = DateFormatter()
        input.dateFormat = "HH:mm"
        guard let date = input.date(from: viewModel.uiState.selectedTime) else {
            return viewModel.uiState.selectedTime
        }
        let output = DateFormatter()
        output.dateStyle = .none
        output.timeStyle = .short
        return output.string(from: date)
    }

    private var reasonField: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
            HStack(spacing: 4) {
                Text("Reason for Visit")
                    .font(.wellnessCaption)
                    .fontWeight(.medium)
                    .foregroundColor(reasonFocused ? .wellnessTeal : .wellnessMuted)
                Text("*")
                    .font(.wellnessCaption)
                    .fontWeight(.medium)
                    .foregroundColor(.wellnessError)
            }

            ZStack(alignment: .topLeading) {
                if viewModel.uiState.reason.isEmpty {
                    Text("Describe your symptoms or visit purpose")
                        .font(.wellnessBody)
                        .foregroundColor(.wellnessMuted)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                }
                TextEditor(
                    text: Binding(
                        get: { viewModel.uiState.reason },
                        set: { viewModel.onEvent(.reasonChanged($0)) }
                    )
                )
                .font(.wellnessBody)
                .foregroundColor(.wellnessOnSurface)
                .scrollContentBackground(.hidden)
                .focused($reasonFocused)
                .frame(minHeight: 90, maxHeight: 140)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
            }
            .background(Color.wellnessSurface)
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
            .overlay(
                RoundedRectangle(cornerRadius: WellnessRadius.small)
                    .stroke(reasonFocused ? Color.wellnessTeal : Color.wellnessStroke,
                            lineWidth: reasonFocused ? 1.5 : 1)
            )
            .animation(AppAnimation.fast, value: reasonFocused)
        }
    }

    private func confirmRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.wellnessCallout)
                .foregroundColor(.wellnessMuted)
            Spacer(minLength: WellnessSpacing.md)
            Text(value)
                .font(.wellnessCallout)
                .fontWeight(.semibold)
                .foregroundColor(.wellnessOnSurface)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, Layout.cardPadding)
        .padding(.vertical, WellnessSpacing.md)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }
}

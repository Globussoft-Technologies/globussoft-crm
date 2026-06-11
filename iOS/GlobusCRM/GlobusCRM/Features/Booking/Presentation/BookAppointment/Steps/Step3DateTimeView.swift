import SwiftUI

struct Step3DateTimeView: View {
    @ObservedObject var viewModel: BookAppointmentViewModel
    @State private var pickerTime: Date = Step3DateTimeView.dateFromTimeString("09:00")

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: WellnessSpacing.xl) {
                    DatePicker(
                        "Appointment Date",
                        selection: Binding(
                            get: { viewModel.uiState.selectedDate },
                            set: { viewModel.onEvent(.dateChanged($0)) }
                        ),
                        in: Date()...,
                        displayedComponents: .date
                    )
                    .datePickerStyle(.graphical)
                    .tint(.wellnessTeal)

                    VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                        Text("Select Time")
                            .font(.wellnessCallout)
                            .fontWeight(.medium)
                            .foregroundColor(.wellnessOnSurface)

                        DatePicker("", selection: $pickerTime, displayedComponents: .hourAndMinute)
                            .datePickerStyle(.wheel)
                            .labelsHidden()
                            .frame(maxWidth: .infinity)
                            .onChange(of: pickerTime) { newVal in
                                let f = DateFormatter()
                                f.dateFormat = "HH:mm"
                                viewModel.onEvent(.timeChanged(f.string(from: newVal)))
                            }
                    }
                    .padding(Layout.cardPadding)
                    .background(Color.wellnessSurface)
                    .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
                }
                .padding(Layout.pagePadding)
            }

            VStack {
                Divider()
                WellnessButton("Next") { viewModel.onEvent(.nextStep) }
                    .padding(.horizontal, Layout.pagePadding)
                    .padding(.vertical, WellnessSpacing.md)
            }
            .background(Color.wellnessBackground)
        }
        .onAppear {
            pickerTime = Step3DateTimeView.dateFromTimeString(viewModel.uiState.selectedTime)
        }
    }

    private static func dateFromTimeString(_ time: String) -> Date {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.date(from: time) ?? Date()
    }
}

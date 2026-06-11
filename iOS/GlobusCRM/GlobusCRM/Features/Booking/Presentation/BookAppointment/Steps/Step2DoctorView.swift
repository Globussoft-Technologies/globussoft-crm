import SwiftUI

struct Step2DoctorView: View {
    @ObservedObject var viewModel: BookAppointmentViewModel

    var body: some View {
        List(viewModel.uiState.doctors) { doctor in
            Button {
                viewModel.onEvent(.selectDoctor(doctor))
            } label: {
                HStack(spacing: WellnessSpacing.md) {
                    Image(systemName: doctor.id == nil ? "person.fill.questionmark" : "stethoscope")
                        .foregroundColor(.wellnessTeal)
                        .frame(width: 24)
                        .accessibilityHidden(true)
                    Text(doctor.name)
                        .font(.wellnessBody)
                        .foregroundColor(.wellnessOnSurface)
                    Spacer()
                    if viewModel.uiState.selectedDoctorId == doctor.id {
                        Image(systemName: "checkmark")
                            .foregroundColor(.wellnessTeal)
                            .accessibilityLabel("Selected")
                    }
                }
                .padding(.vertical, WellnessSpacing.sm)
            }
            .buttonStyle(.plain)
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
    }
}

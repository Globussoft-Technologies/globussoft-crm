import SwiftUI

struct BookAppointmentView: View {
    @StateObject var viewModel: BookAppointmentViewModel
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var router: AppRouter

    var body: some View {
        VStack(spacing: 0) {
            if viewModel.uiState.step < 5 {
                ProgressView(value: Double(viewModel.uiState.step), total: 4)
                    .tint(.wellnessTeal)
                    .padding(.horizontal)
                    .padding(.top, WellnessSpacing.xs)
            }

            // Show inline errors for steps 2–3; step 1 and step 4 manage their own error UI
            if let err = viewModel.uiState.error, viewModel.uiState.step > 1, viewModel.uiState.step < 4 {
                ErrorBanner(message: err)
                    .padding(.horizontal, Layout.pagePadding)
                    .padding(.top, WellnessSpacing.sm)
            }

            Group {
                switch viewModel.uiState.step {
                case 1: Step1ServicesView(viewModel: viewModel)
                case 2: Step2DoctorView(viewModel: viewModel)
                case 3: Step3DateTimeView(viewModel: viewModel)
                case 4: Step4ConfirmView(viewModel: viewModel)
                default: BookingSuccessView(appointment: viewModel.uiState.bookingSuccess) {
                    router.popCurrentTabToRoot()
                    router.selectedTab = .bookings
                }
                }
            }
        }
        .navigationTitle(stepTitle)
        .navigationBarTitleDisplayMode(.inline)
        // Hide the system back button on step 1 (success screen — no going back)
        // and on steps 2–4 where the custom step-back button takes its place.
        .navigationBarBackButtonHidden(viewModel.uiState.step != 1)
        .toolbar {
            if viewModel.uiState.step > 1 && viewModel.uiState.step < 5 {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        viewModel.onEvent(.back)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left")
                                .font(.caption.weight(.semibold))
                            Text("Back")
                        }
                        .foregroundColor(.wellnessTeal)
                    }
                }
            }
        }
        .overlay {
            if viewModel.uiState.isBooking { LoadingView() }
        }
        .task { viewModel.onEvent(.reset); viewModel.onEvent(.loadServices) }
    }

    private var stepTitle: String {
        switch viewModel.uiState.step {
        case 1: return "Select Service"
        case 2: return "Choose Doctor"
        case 3: return "Date & Time"
        case 4: return "Confirm Booking"
        default: return "Booking Confirmed"
        }
    }
}

struct BookingSuccessView: View {
    let appointment: Appointment?
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: WellnessSpacing.xl) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: IconSize.hero))
                .foregroundColor(.wellnessTeal)
            Text("Booking Confirmed!")
                .font(.wellnessTitle)
                .foregroundColor(.wellnessOnSurface)
            if let appt = appointment {
                Text(appt.serviceName ?? "Appointment")
                    .font(.wellnessHeadline).foregroundColor(.wellnessMuted)
                Text(DateUtil.formatAppointment(iso: appt.appointmentDate))
                    .font(.wellnessBody).foregroundColor(.wellnessMuted)
            }
            WellnessButton("Done", action: onDone)
                .padding(.horizontal, Layout.pagePadding)
        }
        .padding(Layout.pagePadding)
    }
}

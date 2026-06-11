import SwiftUI

struct MyAppointmentsView: View {
    @StateObject var viewModel: MyAppointmentsViewModel
    @EnvironmentObject var router: AppRouter

    var body: some View {
        List {
            // Bucket filter chips embedded as the first list row so they scroll
            // with the navigation title rather than staying fixed below it.
            bucketFilterRow

            if let err = viewModel.uiState.error {
                ErrorBanner(message: err)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 0, leading: Layout.pagePadding,
                                             bottom: WellnessSpacing.sm, trailing: Layout.pagePadding))
            }

            appointmentRows
        }
        .listStyle(.plain)
        .wellnessListBackground()
        .navigationTitle("My Appointments")
        .navigationBarTitleDisplayMode(.large)
        .toolbar { bookFAB }
        .task { viewModel.onEvent(.refresh) }
        .refreshable { viewModel.onEvent(.refresh) }
        .overlay { if viewModel.uiState.isLoading { LoadingView() } }
        .sheet(item: $viewModel.uiState.activeSheet) { sheet in
            switch sheet {
            case .actions:
                if let appt = viewModel.uiState.selectedAppointment {
                    AppointmentActionsSheet(
                        appointment: appt,
                        onViewDetails: { viewModel.onEvent(.viewDetails) },
                        onReschedule: { viewModel.uiState.activeSheet = .reschedule },
                        onCancel: { viewModel.uiState.activeSheet = .cancel },
                        onDismiss: { viewModel.onEvent(.dismissActionSheet) }
                    )
                    .presentationDetents([.fraction(0.45), .medium])
                    .presentationDragIndicator(.visible)
                }
            case .detail:
                if let appt = viewModel.uiState.selectedAppointment {
                    AppointmentDetailSheet(appointment: appt)
                }
            case .reschedule:
                RescheduleSheet(viewModel: viewModel)
            case .cancel:
                if let appt = viewModel.uiState.selectedAppointment {
                    CancelConfirmSheet(appointment: appt) {
                        viewModel.onEvent(.cancelAppointment(id: appt.id))
                    } onDismiss: {
                        viewModel.uiState.activeSheet = nil
                    }
                }
            }
        }
    }

    // MARK: - Bucket filter row

    @ViewBuilder
    private var bucketFilterRow: some View {
        HStack(spacing: Layout.itemSpacing) {
            ForEach(AppointmentBucket.allCases, id: \.self) { bucket in
                let count = viewModel.uiState.appointments[bucket.rawValue]?.count ?? 0
                let isSelected = viewModel.uiState.selectedBucket == bucket
                Button { viewModel.onEvent(.selectBucket(bucket)) } label: {
                    VStack(spacing: WellnessSpacing.xs) {
                        Text("\(count)")
                            .font(.system(.title3, design: .rounded).weight(.bold))
                            .foregroundColor(isSelected ? bucketColor(bucket) : .wellnessOnSurface)
                            .contentTransition(.numericText())
                            .animation(.easeInOut(duration: 0.3), value: count)
                        Text(bucket.displayName)
                            .font(.wellnessCaption2)
                            .foregroundColor(isSelected ? bucketColor(bucket) : .wellnessMuted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, WellnessSpacing.sm)
                    .background(isSelected ? bucketColor(bucket).opacity(0.1) : Color.wellnessSurface)
                    .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
                    .overlay(
                        RoundedRectangle(cornerRadius: WellnessRadius.medium)
                            .strokeBorder(isSelected ? bucketColor(bucket) : Color.clear, lineWidth: 1.5)
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .listRowBackground(Color.wellnessBackground)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: WellnessSpacing.md, leading: Layout.pagePadding,
                                  bottom: WellnessSpacing.md, trailing: Layout.pagePadding))
    }

    // MARK: - Appointment rows

    @ViewBuilder
    private var appointmentRows: some View {
        let appts = viewModel.uiState.appointments[viewModel.uiState.selectedBucket.rawValue] ?? []
        if appts.isEmpty && !viewModel.uiState.isLoading {
            EmptyStateView(
                icon: "calendar.badge.exclamationmark",
                title: "No appointments",
                subtitle: "You have no \(viewModel.uiState.selectedBucket.displayName.lowercased()) appointments."
            )
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        } else {
            ForEach(appts) { appt in
                AppointmentCard(appointment: appt) {
                    viewModel.onEvent(.tapAppointment(appt))
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(
                    top: WellnessSpacing.xs,
                    leading: Layout.pagePadding,
                    bottom: WellnessSpacing.xs,
                    trailing: Layout.pagePadding
                ))
                .swipeActions(edge: .leading, allowsFullSwipe: false) {
                    if appt.canReschedule {
                        Button {
                            viewModel.uiState.selectedAppointment = appt
                            viewModel.uiState.activeSheet = .reschedule
                        } label: {
                            Label("Reschedule", systemImage: "calendar.badge.clock")
                        }
                        .tint(.wellnessTeal)
                    }
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    if appt.canCancel {
                        Button(role: .destructive) {
                            viewModel.uiState.selectedAppointment = appt
                            viewModel.uiState.activeSheet = .cancel
                        } label: {
                            Label("Cancel", systemImage: "xmark.circle.fill")
                        }
                    }
                }
                .contextMenu {
                    Button {
                        viewModel.uiState.selectedAppointment = appt
                        viewModel.uiState.activeSheet = .detail
                    } label: {
                        Label("View Details", systemImage: "info.circle")
                    }
                    if appt.canReschedule {
                        Button {
                            viewModel.uiState.selectedAppointment = appt
                            viewModel.uiState.activeSheet = .reschedule
                        } label: {
                            Label("Reschedule", systemImage: "calendar.badge.clock")
                        }
                    }
                    if appt.canCancel {
                        Button(role: .destructive) {
                            viewModel.uiState.selectedAppointment = appt
                            viewModel.uiState.activeSheet = .cancel
                        } label: {
                            Label("Cancel Appointment", systemImage: "xmark.circle")
                        }
                    }
                }
            }
        }
    }

    private func bucketColor(_ bucket: AppointmentBucket) -> Color {
        switch bucket {
        case .upcoming:   return .wellnessTeal
        case .pending:    return .wellnessGold
        case .past:       return .wellnessOnSurface
        case .cancelled:  return .wellnessError
        }
    }

    private var bookFAB: some ToolbarContent {
        ToolbarItem(placement: .navigationBarTrailing) {
            Button { router.navigate(to: .bookAppointment()) } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: IconSize.fab))
            }
            .accessibilityLabel("Book appointment")
        }
    }
}

// MARK: - Appointment Actions Sheet

private struct AppointmentActionsSheet: View {
    let appointment: Appointment
    let onViewDetails: () -> Void
    let onReschedule: () -> Void
    let onCancel: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Appointment context header
            VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                        Text(appointment.serviceName ?? "Appointment")
                            .font(.wellnessTitle3)
                            .fontWeight(.semibold)
                            .foregroundColor(.wellnessOnSurface)
                            .lineLimit(2)
                        if let doctor = appointment.doctorName {
                            Label(doctor, systemImage: "person.circle")
                                .font(.wellnessBody)
                                .foregroundColor(.wellnessMuted)
                        }
                        Label(DateUtil.formatAppointment(iso: appointment.appointmentDate),
                              systemImage: "calendar")
                            .font(.wellnessBody)
                            .foregroundColor(.wellnessMuted)
                    }
                    Spacer()
                    StatusBadge(status: appointment.status.displayName)
                }
            }
            .padding(.horizontal, Layout.pagePadding)
            .padding(.top, WellnessSpacing.lg)
            .padding(.bottom, WellnessSpacing.md)

            Divider()
                .padding(.horizontal, Layout.pagePadding)

            // Action buttons
            VStack(spacing: 0) {
                ActionRow(
                    icon: "info.circle",
                    title: "View Details",
                    color: .wellnessOnSurface,
                    action: onViewDetails
                )

                if appointment.canReschedule {
                    Divider().padding(.leading, 52)
                    ActionRow(
                        icon: "calendar.badge.clock",
                        title: "Reschedule",
                        color: .wellnessTeal,
                        action: onReschedule
                    )
                }

                if appointment.canCancel {
                    Divider().padding(.leading, 52)
                    ActionRow(
                        icon: "xmark.circle",
                        title: "Cancel Appointment",
                        color: .wellnessError,
                        action: onCancel
                    )
                }
            }
            .background(Color.wellnessSurface)
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
            .padding(.horizontal, Layout.pagePadding)
            .padding(.top, WellnessSpacing.md)

            Spacer(minLength: WellnessSpacing.xl)
        }
        .background(Color.wellnessBackground.ignoresSafeArea())
    }
}

private struct ActionRow: View {
    let icon: String
    let title: String
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: WellnessSpacing.md) {
                Image(systemName: icon)
                    .font(.system(size: IconSize.small))
                    .foregroundColor(color)
                    .frame(width: 28)
                Text(title)
                    .font(.wellnessBody)
                    .foregroundColor(color)
                Spacer()
            }
            .padding(.horizontal, Layout.cardPadding)
            .padding(.vertical, WellnessSpacing.md)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Appointment Card

struct AppointmentCard: View {
    let appointment: Appointment
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            WellnessCard {
                VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                    HStack {
                        MarqueeText(
                            text: appointment.serviceName ?? "Appointment",
                            font: .wellnessHeadline,
                            foregroundColor: .wellnessOnSurface
                        )
                        Spacer(minLength: WellnessSpacing.sm)
                        StatusBadge(status: appointment.status.displayName)
                    }
                    if let doctor = appointment.doctorName {
                        HStack(spacing: WellnessSpacing.xs) {
                            Image(systemName: "person.circle")
                                .font(.wellnessBody)
                                .foregroundColor(.wellnessMuted)
                                .accessibilityHidden(true)
                            MarqueeText(
                                text: doctor,
                                font: .wellnessBody,
                                foregroundColor: .wellnessMuted
                            )
                        }
                    }
                    Label(DateUtil.formatAppointment(iso: appointment.appointmentDate), systemImage: "calendar")
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessMuted)

                    if appointment.bookingType == "video", let url = appointment.videoCallUrl,
                       let videoURL = URL(string: url) {
                        Link(destination: videoURL) {
                            Label("Join Video Call", systemImage: "video.fill")
                                .font(.wellnessCallout)
                                .fontWeight(.semibold)
                                .foregroundColor(.wellnessTeal)
                        }
                    }
                }
                .padding(Layout.cardPadding)
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Appointment Detail Sheet

struct AppointmentDetailSheet: View {
    let appointment: Appointment
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: WellnessSpacing.lg) {
                    ZStack {
                        Circle()
                            .fill(Color.wellnessTeal.opacity(0.12))
                            .frame(width: 64, height: 64)
                        Image(systemName: "calendar.badge.clock")
                            .font(.system(size: IconSize.row))
                            .foregroundColor(.wellnessTeal)
                            .accessibilityHidden(true)
                    }
                    .padding(.top, WellnessSpacing.lg)

                    Text(appointment.serviceName ?? "Appointment")
                        .font(.wellnessTitle3)
                        .fontWeight(.semibold)
                        .foregroundColor(.wellnessOnSurface)
                        .multilineTextAlignment(.center)

                    StatusBadge(status: appointment.status.displayName)

                    VStack(spacing: 0) {
                        if let doctor = appointment.doctorName {
                            DetailRow(label: "Doctor", value: doctor)
                            Divider().padding(.leading, Layout.cardPadding)
                        }
                        DetailRow(label: "Date & Time",
                                  value: DateUtil.formatAppointment(iso: appointment.appointmentDate))
                        if let reason = appointment.reason, !reason.isEmpty {
                            Divider().padding(.leading, Layout.cardPadding)
                            DetailRow(label: "Reason", value: reason)
                        }
                        if let type = appointment.bookingType {
                            Divider().padding(.leading, Layout.cardPadding)
                            DetailRow(label: "Type", value: type.capitalized)
                        }
                    }
                    .background(Color.wellnessSurface)
                    .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
                    .padding(.horizontal, Layout.pagePadding)

                    if let url = appointment.videoCallUrl, !url.isEmpty,
                       let videoURL = URL(string: url) {
                        Link(destination: videoURL) {
                            Label("Join Video Call", systemImage: "video.fill")
                                .font(.wellnessCallout)
                                .fontWeight(.semibold)
                                .foregroundColor(.wellnessTeal)
                        }
                    }
                }
                .padding(.bottom, WellnessSpacing.xl)
            }
            .background(Color.wellnessBackground.ignoresSafeArea())
            .navigationTitle("Appointment Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - Cancel Confirm Sheet

private struct CancelConfirmSheet: View {
    let appointment: Appointment
    let onConfirm: () -> Void
    let onDismiss: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(spacing: WellnessSpacing.xl) {
                        ZStack {
                            Circle()
                                .fill(Color.wellnessError.opacity(0.12))
                                .frame(width: 72, height: 72)
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: IconSize.accent))
                                .foregroundColor(.wellnessError)
                        }
                        .padding(.top, WellnessSpacing.xl)

                        VStack(spacing: WellnessSpacing.sm) {
                            Text("Cancel Appointment?")
                                .font(.wellnessTitle2)
                                .fontWeight(.bold)
                                .foregroundColor(.wellnessOnSurface)
                                .multilineTextAlignment(.center)
                            Text("This action cannot be undone.")
                                .font(.wellnessBody)
                                .foregroundColor(.wellnessMuted)
                                .multilineTextAlignment(.center)
                        }
                        .padding(.horizontal, Layout.pagePadding)

                        VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                            Text(appointment.serviceName ?? "Appointment")
                                .font(.wellnessHeadline)
                                .foregroundColor(.wellnessOnSurface)
                            if let doctor = appointment.doctorName {
                                Label(doctor, systemImage: "person.circle")
                                    .font(.wellnessBody)
                                    .foregroundColor(.wellnessMuted)
                            }
                            Label(DateUtil.formatAppointment(iso: appointment.appointmentDate),
                                  systemImage: "calendar")
                                .font(.wellnessBody)
                                .foregroundColor(.wellnessMuted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Layout.cardPadding)
                        .background(Color.wellnessSurface)
                        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
                        .padding(.horizontal, Layout.pagePadding)
                    }
                    .padding(.bottom, WellnessSpacing.lg)
                }

                VStack(spacing: WellnessSpacing.sm) {
                    Divider()
                    Button(role: .destructive) {
                        onConfirm()
                        dismiss()
                    } label: {
                        Text("Cancel Appointment")
                            .font(.wellnessBody)
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, WellnessSpacing.md)
                            .background(Color.wellnessError)
                            .foregroundColor(.white)
                            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
                    }
                    .buttonStyle(.plain)

                    Button {
                        onDismiss()
                        dismiss()
                    } label: {
                        Text("Keep Appointment")
                            .font(.wellnessBody)
                            .fontWeight(.medium)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, WellnessSpacing.md)
                            .background(Color.wellnessSurface)
                            .foregroundColor(.wellnessOnSurface)
                            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, Layout.pagePadding)
                .padding(.bottom, WellnessSpacing.xl)
                .background(Color.wellnessBackground)
            }
            .background(Color.wellnessBackground.ignoresSafeArea())
            .navigationTitle("Cancel Appointment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { onDismiss(); dismiss() }
                }
            }
        }
    }
}

// MARK: - Reschedule Sheet

struct RescheduleSheet: View {
    @ObservedObject var viewModel: MyAppointmentsViewModel
    @State private var date = Date()
    @State private var time = Date()

    var body: some View {
        NavigationStack {
            VStack(spacing: WellnessSpacing.xl) {
                if let appt = viewModel.uiState.selectedAppointment {
                    VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                        Text("Rescheduling")
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessMuted)
                        Text(appt.serviceName ?? "Appointment")
                            .font(.wellnessHeadline)
                            .foregroundColor(.wellnessOnSurface)
                        Label(DateUtil.formatAppointment(iso: appt.appointmentDate), systemImage: "calendar")
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Layout.cardPadding)
                    .background(Color.wellnessTeal.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
                }

                DatePicker("New Date", selection: $date, in: Date()..., displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .tint(.wellnessTeal)

                DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                    .datePickerStyle(.wheel)
                    .frame(height: 120)
                    .clipped()

                Spacer()

                WellnessButton("Confirm Reschedule") {
                    let dateStr = DateUtil.toApiDate(date)
                    let formatter = DateFormatter()
                    formatter.dateFormat = "HH:mm"
                    let timeStr = formatter.string(from: time)
                    if let id = viewModel.uiState.selectedAppointment?.id {
                        viewModel.onEvent(.reschedule(id: id, date: dateStr, time: timeStr))
                    }
                }
                .padding(.horizontal, Layout.pagePadding)
                .padding(.bottom, WellnessSpacing.md)
            }
            .padding(.horizontal, Layout.pagePadding)
            .padding(.top, WellnessSpacing.lg)
            .background(Color.wellnessBackground.ignoresSafeArea())
            .navigationTitle("Reschedule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { viewModel.uiState.activeSheet = nil }
                }
            }
        }
        .presentationDetents([.large])
        .onAppear {
            if let appt = viewModel.uiState.selectedAppointment,
               let parsed = ISO8601DateFormatter().date(from: appt.appointmentDate) {
                date = parsed
                time = parsed
            }
        }
    }
}

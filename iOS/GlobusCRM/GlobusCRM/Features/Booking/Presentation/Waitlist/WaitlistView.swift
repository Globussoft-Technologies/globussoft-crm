import SwiftUI

struct WaitlistView: View {
    @StateObject var viewModel: WaitlistViewModel
    @State private var showAddSheet = false

    var body: some View {
        Group {
            if viewModel.isLoading {
                LoadingView()
            } else if let err = viewModel.error {
                ErrorStateView(message: err) { Task { await viewModel.load() } }
            } else if viewModel.entries.isEmpty {
                EmptyStateView(icon: "clock.badge.questionmark", title: "Waitlist empty",
                               subtitle: "Add yourself to the waitlist for a service.")
            } else {
                List(viewModel.entries) { entry in
                    WaitlistEntryRow(entry: entry)
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
                .wellnessListBackground()
                .refreshable { await viewModel.load() }
            }
        }
        .navigationTitle("Waitlist")
        .navigationBarTitleDisplayMode(.large)
        .background(Color.wellnessBackground.ignoresSafeArea())
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { showAddSheet = true } label: { Image(systemName: "plus") }
            }
        }
        .task { await viewModel.load() }
        .sheet(isPresented: $showAddSheet) {
            AddWaitlistSheet(viewModel: viewModel, isPresented: $showAddSheet)
        }
    }
}

struct WaitlistEntryRow: View {
    let entry: WaitlistEntry

    var body: some View {
        WellnessCard {
            HStack(spacing: WellnessSpacing.md) {
                VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                    MarqueeText(
                        text: entry.serviceName ?? "Service #\(entry.serviceId)",
                        font: .wellnessSubheadline,
                        foregroundColor: .wellnessOnSurface
                    )
                    Text("Added \(DateUtil.formatDate(iso: entry.createdAt))")
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessMuted)
                    if let notes = entry.notes {
                        Text(notes)
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessMuted)
                            .lineLimit(2)
                    }
                }
                Spacer()
                StatusBadge(status: entry.status.rawValue.capitalized)
            }
            .padding(Layout.cardPadding)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.serviceName ?? "Service"). Status: \(entry.status.rawValue)")
    }
}

struct AddWaitlistSheet: View {
    @ObservedObject var viewModel: WaitlistViewModel
    @Binding var isPresented: Bool
    @State private var notes = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Service") {
                    Picker("Select service", selection: $viewModel.selectedServiceId) {
                        Text("Select a service").tag(Int?.none)
                        ForEach(viewModel.services) { service in
                            Text(service.name).tag(Optional(service.id))
                        }
                    }
                    .tint(.wellnessTeal)
                }
                Section("Notes (optional)") {
                    TextField("Any preferences or notes...", text: $notes, axis: .vertical)
                        .lineLimit(3...5)
                }
            }
            .navigationTitle("Join Waitlist")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { isPresented = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Submit") {
                        Task {
                            await viewModel.addToWaitlist(notes: notes)
                            isPresented = false
                        }
                    }
                    .disabled(viewModel.selectedServiceId == nil)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

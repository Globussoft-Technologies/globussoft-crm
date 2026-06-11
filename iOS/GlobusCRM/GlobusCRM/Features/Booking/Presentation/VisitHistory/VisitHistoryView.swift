import SwiftUI

struct VisitHistoryView: View {
    @StateObject var viewModel: VisitHistoryViewModel
    @State private var selectedVisit: Visit?

    var body: some View {
        Group {
            if !viewModel.hasLoaded {
                SkeletonListView(count: 5, cardHeight: 72)
            } else if let err = viewModel.error {
                ErrorStateView(message: err) { Task { await viewModel.load() } }
            } else if viewModel.visits.isEmpty {
                EmptyStateView(icon: "clock.badge.checkmark", title: "No visits yet",
                               subtitle: "Your visit history will appear here.")
            } else {
                List {
                    ForEach(viewModel.groupedMonths, id: \.self) { month in
                        Section {
                            ForEach(viewModel.visits(for: month)) { visit in
                                Button { selectedVisit = visit } label: {
                                    VisitRow(visit: visit)
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
                        } header: {
                            Text(month)
                                .font(.wellnessCaption)
                                .fontWeight(.semibold)
                                .foregroundColor(.wellnessMuted)
                                .textCase(nil)
                                .padding(.leading, Layout.pagePadding)
                                .padding(.bottom, WellnessSpacing.xs)
                        }
                    }
                }
                .wellnessListBackground()
                .refreshable { await viewModel.load() }
            }
        }
        .background(Color.wellnessBackground)
        .navigationTitle("Visit History")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.load() }
        .sheet(item: $selectedVisit) { visit in
            VisitHistoryDetailSheet(visit: visit)
        }
    }
}

struct VisitRow: View {
    let visit: Visit

    var body: some View {
        WellnessCard {
            HStack {
                VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                    MarqueeText(
                        text: visit.serviceName,
                        font: .wellnessHeadline,
                        foregroundColor: .wellnessOnSurface
                    )
                    MarqueeText(
                        text: visit.doctorName,
                        font: .wellnessBody,
                        foregroundColor: .wellnessMuted
                    )
                    Text(DateUtil.formatDate(iso: visit.visitDate))
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessMuted)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: WellnessSpacing.xs) {
                    Text(CurrencyUtil.formatINR(visit.amountCharged))
                        .font(.wellnessCallout)
                        .fontWeight(.semibold)
                        .foregroundColor(.wellnessOnSurface)
                    StatusBadge(status: visit.status.capitalized)
                }
            }
            .padding(Layout.cardPadding)
        }
    }
}

// MARK: - Visit Detail Sheet

private struct VisitHistoryDetailSheet: View {
    let visit: Visit
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: WellnessSpacing.lg) {
                    ZStack {
                        Circle()
                            .fill(Color.wellnessTeal.opacity(0.12))
                            .frame(width: 64, height: 64)
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: IconSize.row))
                            .foregroundColor(.wellnessTeal)
                            .accessibilityHidden(true)
                    }
                    .padding(.top, WellnessSpacing.lg)

                    Text(visit.serviceName)
                        .font(.wellnessTitle3)
                        .fontWeight(.semibold)
                        .foregroundColor(.wellnessOnSurface)
                        .multilineTextAlignment(.center)

                    VStack(spacing: 0) {
                        DetailRow(label: "Doctor", value: visit.doctorName)
                        Divider().padding(.leading, Layout.cardPadding)
                        DetailRow(label: "Date", value: DateUtil.formatDate(iso: visit.visitDate))
                        Divider().padding(.leading, Layout.cardPadding)
                        DetailRow(label: "Status", value: visit.status.capitalized)
                        Divider().padding(.leading, Layout.cardPadding)
                        DetailRow(label: "Amount", value: CurrencyUtil.formatINR(visit.amountCharged))
                        if let location = visit.locationName {
                            Divider().padding(.leading, Layout.cardPadding)
                            DetailRow(label: "Location", value: location)
                        }
                        if let type = visit.bookingType {
                            Divider().padding(.leading, Layout.cardPadding)
                            DetailRow(label: "Type", value: type.capitalized)
                        }
                    }
                    .background(Color.wellnessSurface)
                    .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
                    .padding(.horizontal, Layout.pagePadding)

                    if let url = visit.videoCallUrl, !url.isEmpty, let videoURL = URL(string: url) {
                        Link(destination: videoURL) {
                            Label("Join Video Call", systemImage: "video.fill")
                                .font(.wellnessCallout)
                                .fontWeight(.semibold)
                                .foregroundColor(.wellnessTeal)
                                .padding(.horizontal, Layout.pagePadding)
                        }
                    }
                }
                .padding(.bottom, WellnessSpacing.xl)
            }
            .background(Color.wellnessBackground.ignoresSafeArea())
            .navigationTitle("Visit Details")
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

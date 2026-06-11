import SwiftUI

struct TreatmentPlansView: View {
    @StateObject var viewModel: TreatmentPlansViewModel

    var body: some View {
        Group {
            if !viewModel.hasLoaded {
                SkeletonListView(count: 4, cardHeight: 88)
            } else if let error = viewModel.error {
                ErrorStateView(message: error) { Task { await viewModel.load() } }
            } else if viewModel.plans.isEmpty {
                EmptyStateView(
                    icon: "list.clipboard",
                    title: "No Treatment Plans",
                    subtitle: "Your treatment plans will appear here."
                )
            } else {
                List(viewModel.plans) { plan in
                    TreatmentPlanRowView(plan: plan)
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
                .refreshable { await viewModel.load() }
            }
        }
        .background(Color.wellnessBackground)
        .navigationTitle("Treatment Plans")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.load() }
    }
}

struct TreatmentPlanRowView: View {
    let plan: TreatmentPlan

    var body: some View {
        WellnessCard {
            VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                HStack {
                    Text(plan.name)
                        .font(.wellnessSubheadline)
                        .foregroundColor(.wellnessOnSurface)
                    Spacer()
                    StatusBadge(status: plan.status.capitalized)
                }

                if let serviceName = plan.serviceName {
                    let subtitle = plan.serviceCategory.map { "\(serviceName) · \($0)" } ?? serviceName
                    Text(subtitle)
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessMuted)
                        .lineLimit(2)
                }

                VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                    HStack {
                        Text("\(plan.sessionsCompleted) / \(plan.sessionsTotal) sessions")
                            .font(.wellnessCaption2)
                            .foregroundColor(.wellnessMuted)
                        Spacer()
                        Text("\(Int(plan.progressFraction * 100))%")
                            .font(.wellnessCaption2)
                            .fontWeight(.semibold)
                            .foregroundColor(.wellnessTeal)
                    }
                    ProgressView(value: plan.progressFraction)
                        .tint(.wellnessTeal)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(plan.sessionsCompleted) of \(plan.sessionsTotal) sessions completed, \(Int(plan.progressFraction * 100)) percent")

                if let start = plan.startedAt {
                    Label("Started: \(DateUtil.formatDate(iso: start))", systemImage: "calendar")
                        .font(.wellnessCaption2)
                        .foregroundColor(.wellnessMuted)
                }
                if let next = plan.nextDueAt {
                    Label("Next due: \(DateUtil.formatDate(iso: next))", systemImage: "calendar.badge.clock")
                        .font(.wellnessCaption2)
                        .foregroundColor(.wellnessTeal)
                }
            }
            .padding(Layout.cardPadding)
        }
    }
}

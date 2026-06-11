import SwiftUI

struct MembershipView: View {
    @ObservedObject var viewModel: MembershipViewModel
    @EnvironmentObject var appState: AppState

    var body: some View {
        VStack(spacing: 0) {
            // Tab selector
            Picker("", selection: Binding(
                get: { viewModel.uiState.selectedTab },
                set: { viewModel.selectTab($0) }
            )) {
                ForEach(MembershipTab.allCases, id: \.self) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Layout.pagePadding)
            .padding(.vertical, WellnessSpacing.md)

            if viewModel.uiState.isLoading {
                Spacer()
                LoadingView()
                Spacer()
            } else if let error = viewModel.uiState.error {
                Spacer()
                ErrorStateView(message: error) { Task { await viewModel.load() } }
                Spacer()
            } else {
                switch viewModel.uiState.selectedTab {
                case .available:
                    availablePlansSection
                case .mine:
                    myMembershipsSection
                }
            }
        }
        .navigationTitle("Memberships")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.load() }
        .confirmationDialog(
            "Join \(viewModel.uiState.planToJoin?.name ?? "")?",
            isPresented: Binding(
                get: { viewModel.uiState.planToJoin != nil },
                set: { if !$0 { viewModel.cancelJoin() } }
            ),
            titleVisibility: .visible
        ) {
            Button("Join Plan", role: .none) { Task { await viewModel.confirmJoin() } }
            Button("Cancel", role: .cancel) { viewModel.cancelJoin() }
        } message: {
            if let plan = viewModel.uiState.planToJoin {
                Text("You will be enrolled in the \(plan.name) plan for \(CurrencyUtil.formatAmount(plan.price, currency: plan.currency)).")
            }
        }
        .overlay {
            if viewModel.uiState.isJoining {
                Color.black.opacity(0.3).ignoresSafeArea()
                    .overlay(ProgressView().tint(.white))
            }
        }
    }

    @ViewBuilder
    private var availablePlansSection: some View {
        if viewModel.uiState.availablePlans.isEmpty {
            EmptyStateView(icon: "star.circle", title: "No Plans Available", subtitle: "Check back later for membership plans.")
        } else {
            ScrollView {
                LazyVStack(spacing: Layout.itemSpacing) {
                    ForEach(viewModel.uiState.availablePlans) { plan in
                        MembershipPlanCard(plan: plan) {
                            viewModel.initiateJoin(plan: plan)
                        }
                    }
                }
                .padding(Layout.pagePadding)
            }
        }
    }

    @ViewBuilder
    private var myMembershipsSection: some View {
        if viewModel.uiState.myMemberships.isEmpty {
            EmptyStateView(icon: "person.badge.shield.checkmark", title: "No Active Plans", subtitle: "Join a plan to get started.")
        } else {
            ScrollView {
                LazyVStack(spacing: Layout.itemSpacing) {
                    ForEach(viewModel.uiState.myMemberships) { membership in
                        UserMembershipCard(membership: membership)
                    }
                }
                .padding(Layout.pagePadding)
            }
        }
    }
}

struct MembershipPlanCard: View {
    let plan: MembershipPlan
    let onJoin: () -> Void
    @State private var showDetails = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(alignment: .leading, spacing: 0) {
                // Header: name + price
                VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                    Text(plan.name)
                        .font(.wellnessTitle3)
                        .fontWeight(.bold)
                        .foregroundColor(.white)

                    HStack(alignment: .lastTextBaseline, spacing: WellnessSpacing.xs) {
                        Text(CurrencyUtil.formatAmount(plan.price, currency: plan.currency))
                            .font(.system(.title, design: .default).weight(.heavy))
                            .foregroundColor(.white)
                        Text("/ year")
                            .font(.wellnessCaption)
                            .foregroundColor(.white.opacity(0.75))
                    }
                }
                .padding([.top, .horizontal], Layout.cardPaddingLarge)
                .padding(.bottom, Layout.cardPadding)

                // Entitlements / perks
                if !plan.entitlements.isEmpty {
                    VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                        ForEach(plan.entitlements.prefix(4), id: \.self) { perk in
                            HStack(spacing: WellnessSpacing.sm) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.callout)
                                    .foregroundColor(.white.opacity(0.85))
                                    .accessibilityHidden(true)
                                Text(perk)
                                    .font(.wellnessCaption)
                                    .foregroundColor(.white.opacity(0.9))
                            }
                        }
                    }
                    .padding(.horizontal, Layout.cardPaddingLarge)
                    .padding(.bottom, Layout.cardPaddingLarge)
                } else if let desc = plan.description {
                    Text(desc)
                        .font(.wellnessCaption)
                        .foregroundColor(.white.opacity(0.8))
                        .lineLimit(3)
                        .padding(.horizontal, Layout.cardPaddingLarge)
                        .padding(.bottom, Layout.cardPaddingLarge)
                }

                // Action buttons
                HStack(spacing: WellnessSpacing.md) {
                    Button {
                        showDetails.toggle()
                    } label: {
                        Text("View Details")
                            .font(.wellnessCallout)
                            .fontWeight(.semibold)
                            .foregroundColor(.white)
                            .frame(maxWidth: .infinity)
                            .frame(height: Layout.minTapTarget)
                            .overlay(
                                RoundedRectangle(cornerRadius: WellnessRadius.medium)
                                    .stroke(Color.white.opacity(0.6), lineWidth: 1.5)
                            )
                    }
                    .buttonStyle(.plain)

                    Button(action: onJoin) {
                        Text("Join Now")
                            .font(.wellnessCallout)
                            .fontWeight(.bold)
                            .foregroundColor(plan.tier.color)
                            .frame(maxWidth: .infinity)
                            .frame(height: Layout.minTapTarget)
                            .background(Color.white)
                            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, Layout.cardPaddingLarge)
                .padding(.bottom, Layout.cardPaddingLarge)

                // Expanded details
                if showDetails {
                    Divider()
                        .background(Color.white.opacity(0.2))
                        .padding(.horizontal, Layout.cardPaddingLarge)

                    VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                        if let desc = plan.description {
                            Text(desc)
                                .font(.wellnessCaption)
                                .foregroundColor(.white.opacity(0.85))
                        }
                        Text("Duration: \(plan.durationDays) days")
                            .font(.wellnessCaption)
                            .foregroundColor(.white.opacity(0.75))
                    }
                    .padding(Layout.cardPaddingLarge)
                }
            }
            .background(plan.tier.color)
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
            .shadow(color: plan.tier.color.opacity(0.4), radius: 12, x: 0, y: 6)

            // Watermark icon
            Image(systemName: "star.circle.fill")
                .font(.system(size: 64))
                .foregroundColor(.white.opacity(0.06))
                .offset(x: -12, y: 12)
        }
        .clipped()
    }
}

struct UserMembershipCard: View {
    let membership: UserMembership

    var body: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.md) {
            LinearGradient(colors: membership.tier.gradientColors, startPoint: .topLeading, endPoint: .bottomTrailing)
                .frame(height: 6)
                .clipShape(Capsule())

            HStack {
                VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                    Text(membership.planName)
                        .font(.wellnessTitle3)
                        .foregroundColor(.wellnessOnSurface)
                    Text(membership.tier.rawValue)
                        .font(.wellnessCaption)
                        .foregroundColor(membership.tier.color)
                }
                Spacer()
                StatusBadge(status: membership.status.capitalized)
            }

            HStack {
                VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                    Text("Valid Until")
                        .font(.wellnessCaption2)
                        .foregroundColor(.wellnessMuted)
                    Text(DateUtil.formatDate(iso: membership.endDate))
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessOnSurface)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: WellnessSpacing.xs) {
                    Text("Credits")
                        .font(.wellnessCaption2)
                        .foregroundColor(.wellnessMuted)
                    Text(CurrencyUtil.formatINR(membership.creditsRemaining))
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessTeal)
                }
            }
        }
        .padding(Layout.cardPadding)
        .background(Color.wellnessSurface)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
        .shadow(color: .black.opacity(0.06), radius: 8, x: 0, y: 2)
    }
}

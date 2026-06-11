import SwiftUI

struct CatalogTabView: View {
    @StateObject var viewModel: CatalogViewModel
    @ObservedObject var membershipViewModel: MembershipViewModel
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var router: AppRouter
    @State private var selectedTab = 0

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $selectedTab) {
                Text("Services").tag(0)
                Text("Categories").tag(1)
                Text("Memberships").tag(2)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Layout.pagePadding)
            .padding(.vertical, WellnessSpacing.md)

            TabView(selection: $selectedTab) {
                servicesTab.tag(0)
                categoriesTab.tag(1)
                membershipsTab.tag(2)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
        }
        .navigationTitle("Catalog")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.load() }
        .sheet(item: $viewModel.selectedService) { service in
            ServiceDetailSheet(service: service, onBook: {
                viewModel.dismissServiceDetail()
                router.navigate(to: .bookAppointment())
            })
        }
    }

    @ViewBuilder
    private var servicesTab: some View {
        VStack(spacing: 0) {
            SearchBar(text: $viewModel.searchText)
                .padding(.horizontal, Layout.pagePadding)
                .padding(.bottom, WellnessSpacing.sm)

            if !viewModel.categories.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: WellnessSpacing.sm) {
                        CategoryChip(label: "All", isSelected: viewModel.selectedCategory == nil) {
                            viewModel.selectCategory(nil)
                        }
                        ForEach(viewModel.categories) { cat in
                            CategoryChip(label: cat.name, isSelected: viewModel.selectedCategory?.id == cat.id) {
                                viewModel.selectCategory(cat)
                            }
                        }
                    }
                    .padding(.horizontal, Layout.pagePadding)
                }
                .padding(.bottom, WellnessSpacing.sm)
            }

            if viewModel.isLoading {
                Spacer()
                LoadingView()
                Spacer()
            } else if let err = viewModel.error {
                Spacer()
                ErrorStateView(message: err) { Task { await viewModel.load() } }
                Spacer()
            } else if viewModel.filteredServices.isEmpty {
                Spacer()
                EmptyStateView(icon: "list.bullet.rectangle", title: "No Services", subtitle: "No services match your search.")
                Spacer()
            } else {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Layout.itemSpacing) {
                        ForEach(viewModel.filteredServices) { service in
                            ServiceGridCard(service: service) {
                                viewModel.selectService(service)
                            }
                        }
                    }
                    .padding(Layout.pagePadding)
                }
                .refreshable { await viewModel.load() }
            }
        }
    }

    @ViewBuilder
    private var categoriesTab: some View {
        if viewModel.categories.isEmpty && !viewModel.isLoading {
            // Wrap in ScrollView so pull-to-refresh still works on empty state
            ScrollView {
                EmptyStateView(icon: "square.grid.2x2", title: "No Categories", subtitle: "Service categories will appear here.")
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
            }
            .refreshable { await viewModel.load() }
        } else {
            List(viewModel.categories) { category in
                CategoryListRow(category: category) {
                    viewModel.searchText = ""
                    viewModel.selectCategory(category)
                    selectedTab = 0
                }
                .wellnessListBackground()
            }
            .listStyle(.plain)
            .refreshable { await viewModel.load() }
        }
    }

    private var membershipsTab: some View {
        MembershipView(viewModel: membershipViewModel)
    }
}

struct ServiceGridCard: View {
    let service: ServiceCatalogItem
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                Text(service.name)
                    .font(.wellnessSubheadline)
                    .fontWeight(.medium)
                    .foregroundColor(.wellnessOnSurface)
                    .lineLimit(2)

                if let cat = service.categoryName, !cat.isEmpty {
                    Text(cat)
                        .font(.wellnessCaption2)
                        .foregroundColor(.wellnessMuted)
                        .padding(.horizontal, WellnessSpacing.sm)
                        .padding(.vertical, WellnessSpacing.xs)
                        .background(Color.wellnessTeal.opacity(0.1))
                        .clipShape(Capsule())
                        .lineLimit(1)
                }

                if let discounted = service.discountedPrice, discounted < service.price {
                    VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                        Text(CurrencyUtil.formatAmount(service.price, currency: service.currency))
                            .font(.wellnessCaption2)
                            .foregroundColor(.wellnessMuted)
                            .strikethrough(true, color: .wellnessMuted)
                        Text(CurrencyUtil.formatAmount(discounted, currency: service.currency))
                            .font(.wellnessCaption2)
                            .fontWeight(.semibold)
                            .foregroundColor(.wellnessTeal)
                    }
                } else {
                    Text(CurrencyUtil.formatAmount(service.price, currency: service.currency))
                        .font(.wellnessCaption2)
                        .foregroundColor(.wellnessTeal)
                }

                if let dur = service.durationMinutes {
                    Text("\(dur) min")
                        .font(.wellnessCaption2)
                        .foregroundColor(.wellnessMuted)
                }
            }
            .padding(Layout.cardPaddingCompact)
            .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
            .background(Color.wellnessSurface)
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
            .shadow(color: .black.opacity(0.05), radius: 4, x: 0, y: 2)
        }
        .buttonStyle(.plain)
    }
}

struct CategoryListRow: View {
    let category: ServiceCategory
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: WellnessSpacing.md) {
                let accent = category.color.flatMap { Color(hex: $0) } ?? .wellnessTeal
                CategoryIconView(imageUrl: category.imageUrl, accent: accent)

                VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                    Text(category.name)
                        .font(.wellnessSubheadline)
                        .foregroundColor(.wellnessOnSurface)
                    if let desc = category.description?.strippingHTML, !desc.isEmpty {
                        Text(desc)
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessMuted)
                            .lineLimit(1)
                    }
                }

                Spacer()

                if category.serviceCount > 0 {
                    Text("\(category.serviceCount)")
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessMuted)
                }
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundColor(.wellnessMuted)
            }
            .padding(.vertical, WellnessSpacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct ServiceDetailSheet: View {
    let service: ServiceCatalogItem
    let onBook: () -> Void
    @Environment(\.dismiss) private var dismiss

    private var severity: (label: String, color: Color)? {
        let p = service.price
        if p >= 25_000 { return ("HIGH", .wellnessError) }
        if p >= 10_000 { return ("MEDIUM", .wellnessGold) }
        return nil
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: WellnessSpacing.xl) {
                    // Title + category + severity pill
                    VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                        HStack(alignment: .top) {
                            Text(service.name)
                                .font(.wellnessTitle2)
                                .foregroundColor(.wellnessOnSurface)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer()
                            if let sev = severity {
                                Text(sev.label)
                                    .font(.wellnessCaption2)
                                    .fontWeight(.bold)
                                    .tracking(0.5)
                                    .foregroundColor(sev.color)
                                    .padding(.horizontal, WellnessSpacing.sm)
                                    .padding(.vertical, WellnessSpacing.xs)
                                    .background(sev.color.opacity(0.12))
                                    .clipShape(Capsule())
                            }
                        }

                        if let category = service.categoryName {
                            Text(category)
                                .font(.wellnessCaption)
                                .foregroundColor(.wellnessMuted)
                        }
                    }

                    // Stat boxes: BASE PRICE | DURATION | STATUS
                    HStack(spacing: WellnessSpacing.sm) {
                        ServiceStatBox(label: "BASE PRICE",
                                       value: CurrencyUtil.formatAmount(service.price, currency: service.currency),
                                       accent: .wellnessTeal)
                        if let dur = service.durationMinutes {
                            ServiceStatBox(label: "DURATION",
                                           value: "\(dur) min",
                                           accent: .wellnessOnSurface)
                        }
                        ServiceStatBox(label: "STATUS",
                                       value: service.isActive ? "Active" : "Inactive",
                                       accent: service.isActive ? .wellnessTeal : .wellnessMuted)
                    }

                    // Discounted price callout
                    if let discounted = service.discountedPrice, discounted < service.price {
                        HStack(spacing: WellnessSpacing.md) {
                            VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                                Text("Discounted Price")
                                    .font(.wellnessCaption2)
                                    .foregroundColor(.wellnessMuted)
                                HStack(alignment: .lastTextBaseline, spacing: WellnessSpacing.sm) {
                                    Text(CurrencyUtil.formatAmount(discounted, currency: service.currency))
                                        .font(.wellnessTitle3)
                                        .foregroundColor(.wellnessTeal)
                                    Text(CurrencyUtil.formatAmount(service.price, currency: service.currency))
                                        .font(.wellnessCaption)
                                        .foregroundColor(.wellnessMuted)
                                        .strikethrough(true, color: .wellnessMuted)
                                }
                            }
                            Spacer()
                        }
                        .padding(Layout.cardPaddingCompact)
                        .background(Color.wellnessTeal.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
                    }

                    // Description
                    if let desc = service.description {
                        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                            Text("About")
                                .font(.wellnessSubheadline)
                                .foregroundColor(.wellnessOnSurface)
                            Text(desc)
                                .font(.wellnessBody)
                                .foregroundColor(.wellnessMuted)
                        }
                    }

                    WellnessButton("Book Service") { onBook() }

                    // Service ID footer
                    HStack {
                        Spacer()
                        Text("Service ID: \(service.id)")
                            .font(.wellnessCaption2)
                            .foregroundColor(.wellnessMuted.opacity(0.6))
                        Spacer()
                    }
                }
                .padding(Layout.pagePadding)
            }
            .background(Color.wellnessBackground.ignoresSafeArea())
            .navigationTitle("Service Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Got it") { dismiss() }
                }
            }
        }
    }
}

private struct ServiceStatBox: View {
    let label: String
    let value: String
    let accent: Color

    var body: some View {
        VStack(spacing: WellnessSpacing.xs) {
            Text(label)
                .font(.wellnessCaption2)
                .fontWeight(.semibold)
                .foregroundColor(.wellnessMuted)
                .tracking(0.3)
            Text(value)
                .font(.wellnessCaption)
                .fontWeight(.semibold)
                .foregroundColor(accent)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, WellnessSpacing.md)
        .background(Color.wellnessSurface)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
        .shadow(color: .black.opacity(0.04), radius: 4, x: 0, y: 1)
    }
}

private struct SearchBar: View {
    @Binding var text: String

    var body: some View {
        HStack {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.wellnessMuted)
            TextField("Search services...", text: $text)
                .font(.wellnessBody)
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.wellnessMuted)
                }
            }
        }
        .padding(WellnessSpacing.md)
        .background(Color.wellnessSurface)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
    }
}

// MARK: - Catalog image helpers

/// Resolves a raw imageUrl string to a URL, handling relative paths.
private func catalogURL(_ raw: String?) -> URL? {
    guard let raw, !raw.isEmpty else { return nil }
    if raw.hasPrefix("http://") || raw.hasPrefix("https://") {
        return URL(string: raw)
    }
    let base = AppConstants.API.baseURL
    let slash = raw.hasPrefix("/") ? "" : "/"
    return URL(string: "\(base)\(slash)\(raw)")
}

/// 36×36 category icon: shows image thumbnail if available, falls back to accent-tinted grid icon.
private struct CategoryIconView: View {
    let imageUrl: String?
    let accent: Color

    var body: some View {
        Group {
            if let url = catalogURL(imageUrl) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        fallbackIcon
                    }
                }
            } else {
                fallbackIcon
            }
        }
        .frame(width: 36, height: 36)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
    }

    private var fallbackIcon: some View {
        RoundedRectangle(cornerRadius: WellnessRadius.small)
            .fill(accent.opacity(0.15))
            .overlay(
                Image(systemName: "square.grid.2x2")
                    .font(.system(size: IconSize.badge))
                    .foregroundColor(accent)
            )
    }
}

private struct CategoryChip: View {
    let label: String
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Text(label)
                .font(.wellnessCaption)
                .padding(.horizontal, WellnessSpacing.md)
                .padding(.vertical, WellnessSpacing.sm)
                .background(isSelected ? Color.wellnessTeal : Color.wellnessSurface)
                .foregroundColor(isSelected ? .white : .wellnessOnSurface)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(isSelected ? Color.clear : Color.wellnessMuted.opacity(0.3), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

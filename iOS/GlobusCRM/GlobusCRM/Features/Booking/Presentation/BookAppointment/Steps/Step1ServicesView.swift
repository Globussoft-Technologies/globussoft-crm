import SwiftUI

struct Step1ServicesView: View {
    @ObservedObject var viewModel: BookAppointmentViewModel

    let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        VStack(spacing: 0) {
            searchBar

            if viewModel.uiState.isLoading {
                Spacer()
                LoadingView()
                Spacer()
            } else if let err = viewModel.uiState.error {
                Spacer()
                ErrorStateView(message: err) {
                    viewModel.onEvent(.loadServices)
                }
                Spacer()
            } else if viewModel.filteredServices.isEmpty {
                Spacer()
                EmptyStateView(
                    icon: "cross.circle",
                    title: "No Services",
                    subtitle: viewModel.uiState.serviceSearchQuery.isEmpty
                        ? "No services are available right now."
                        : "No services match your search."
                )
                Spacer()
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: Layout.itemSpacing) {
                        ForEach(viewModel.filteredServices) { service in
                            BookingServiceCard(service: service) {
                                viewModel.onEvent(.selectService(service))
                            }
                        }
                    }
                    .padding(Layout.pagePadding)
                }
            }
        }
    }

    private var searchBar: some View {
        HStack {
            Image(systemName: "magnifyingglass").foregroundColor(.wellnessMuted)
            TextField("Search services...", text: Binding(
                get: { viewModel.uiState.serviceSearchQuery },
                set: { viewModel.onEvent(.searchChanged($0)) }
            ))
            if !viewModel.uiState.serviceSearchQuery.isEmpty {
                Button { viewModel.onEvent(.searchChanged("")) } label: {
                    Image(systemName: "xmark.circle.fill").foregroundColor(.wellnessMuted)
                }
            }
        }
        .padding(10)
        .background(Color.wellnessSurface)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
        .padding([.horizontal, .top], Layout.pagePadding)
        .padding(.bottom, WellnessSpacing.sm)
    }
}

struct BookingServiceCard: View {
    let service: Product
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            WellnessCard {
                VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                    Text(service.name)
                        .font(.wellnessCallout)
                        .fontWeight(.semibold)
                        .foregroundColor(.wellnessOnSurface)
                        .lineLimit(2)
                    if let price = service.discountedPrice ?? service.basePrice {
                        Text(CurrencyUtil.formatINR(price))
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessTeal)
                    }
                    if let dur = service.durationMin {
                        Text("\(dur) min")
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessMuted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Layout.cardPadding)
            }
        }
        .buttonStyle(.plain)
    }
}

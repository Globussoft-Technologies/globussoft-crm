import SwiftUI

struct ConsentFormsView: View {
    @StateObject var viewModel: ConsentFormsViewModel
    @State private var selectedForm: ConsentForm? = nil

    var body: some View {
        Group {
            if !viewModel.hasLoaded {
                SkeletonListView(count: 4, cardHeight: 64)
            } else if let error = viewModel.error {
                ErrorStateView(message: error) { Task { await viewModel.load() } }
            } else if viewModel.forms.isEmpty {
                EmptyStateView(
                    icon: "doc.text.below.ecg",
                    title: "No Consent Forms",
                    subtitle: "Signed consent forms will appear here."
                )
            } else {
                List(viewModel.forms) { form in
                    Button { selectedForm = form } label: {
                        ConsentFormRowView(form: form)
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
                .refreshable { await viewModel.load() }
            }
        }
        .background(Color.wellnessBackground)
        .navigationTitle("Consent Forms")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.load() }
        .sheet(item: $selectedForm) { form in
            ConsentFormDetailView(form: form)
        }
    }
}

struct ConsentFormRowView: View {
    let form: ConsentForm

    private var statusColor: Color {
        form.isSigned ? .wellnessTeal : .wellnessGold
    }

    var body: some View {
        WellnessCard {
            HStack(spacing: WellnessSpacing.md) {
                Image(systemName: form.isSigned ? "checkmark.seal.fill" : "doc.badge.clock")
                    .font(.system(size: IconSize.medium))
                    .foregroundColor(statusColor)
                    .frame(width: 36)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                    MarqueeText(
                        text: form.title,
                        font: .wellnessSubheadline,
                        foregroundColor: .wellnessOnSurface
                    )
                    if let serviceName = form.serviceName {
                        Text(serviceName)
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessMuted)
                    }
                    if let signedAt = form.signedAt, form.isSigned {
                        Text("Signed: \(DateUtil.formatDate(iso: signedAt))")
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessMuted)
                    } else {
                        Text("Pending signature")
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessGold)
                    }
                }

                Spacer()

                if form.hasPdfBlob {
                    Image(systemName: "doc.richtext")
                        .font(.system(size: IconSize.small))
                        .foregroundColor(.wellnessTeal)
                        .accessibilityLabel("PDF available")
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundColor(.wellnessMuted)
                        .accessibilityHidden(true)
                }
            }
            .padding(Layout.cardPadding)
        }
        .accessibilityLabel(
            "\(form.title). \(form.isSigned ? "Signed" : "Pending signature")"
        )
    }
}

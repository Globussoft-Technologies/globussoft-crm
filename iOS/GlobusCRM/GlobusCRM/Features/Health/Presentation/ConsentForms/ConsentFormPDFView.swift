import SwiftUI

struct ConsentFormDetailView: View {
    let form: ConsentForm
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: WellnessSpacing.xl) {
                    VStack(alignment: .leading, spacing: WellnessSpacing.sm) {
                        Text(form.title)
                            .font(.wellnessTitle3)
                            .foregroundColor(.wellnessOnSurface)
                        Text(form.formType.replacingOccurrences(of: "_", with: " ").capitalized)
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessMuted)
                    }

                    Divider()

                    statusSection

                    if form.isSigned {
                        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                            Text("Signature Status")
                                .font(.wellnessCaption)
                                .foregroundColor(.wellnessMuted)
                            HStack(spacing: WellnessSpacing.xs) {
                                Image(systemName: "checkmark.seal.fill")
                                    .foregroundColor(.wellnessTeal)
                                    .accessibilityHidden(true)
                                Text("Signed")
                                    .font(.wellnessBody)
                                    .foregroundColor(.wellnessOnSurface)
                            }
                            if let signedAt = form.signedAt {
                                Text("on \(DateUtil.formatDate(iso: signedAt))")
                                    .font(.wellnessCaption2)
                                    .foregroundColor(.wellnessMuted)
                            }
                        }
                    } else {
                        HStack(spacing: WellnessSpacing.xs) {
                            Image(systemName: "doc.badge.clock")
                                .foregroundColor(.wellnessGold)
                                .accessibilityHidden(true)
                            Text("Pending signature")
                                .font(.wellnessBody)
                                .foregroundColor(.wellnessGold)
                        }
                    }

                    if let visitId = form.visitId {
                        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                            Text("Associated Visit")
                                .font(.wellnessCaption)
                                .foregroundColor(.wellnessMuted)
                            Text("Visit #\(visitId)")
                                .font(.wellnessBody)
                                .foregroundColor(.wellnessOnSurface)
                        }
                    }
                }
                .padding(Layout.pagePadding)
            }
            .background(Color.wellnessBackground)
            .navigationTitle("Consent Form")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var statusSection: some View {
        HStack {
            VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                Text("Status")
                    .font(.wellnessCaption)
                    .foregroundColor(.wellnessMuted)
                Text(form.isSigned ? "Signed" : "Pending")
                    .font(.wellnessBody)
                    .fontWeight(.semibold)
                    .foregroundColor(form.isSigned ? .wellnessTeal : .wellnessGold)
            }
            Spacer()
            Image(systemName: form.isSigned ? "checkmark.seal.fill" : "doc.badge.clock")
                .font(.system(size: IconSize.accent))
                .foregroundColor(form.isSigned ? .wellnessTeal : .wellnessGold)
                .accessibilityHidden(true)
        }
        .padding(Layout.cardPadding)
        .background(Color.wellnessSurface)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
    }
}

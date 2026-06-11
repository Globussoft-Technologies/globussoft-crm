import SwiftUI

struct ErrorStateView: View {
    let message: String
    var retryAction: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: WellnessSpacing.lg) {
            Image(systemName: Symbols.errorTriangle)
                .font(.system(size: IconSize.large))
                .foregroundColor(.wellnessBlush)

            VStack(spacing: WellnessSpacing.xs) {
                Text("Something went wrong")
                    .font(.wellnessHeadline)
                    .foregroundColor(.wellnessOnSurface)

                Text(message)
                    .font(.wellnessBody)
                    .foregroundColor(.wellnessMuted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, WellnessSpacing.xl)
            }

            if let retry = retryAction {
                WellnessButton("Try Again", action: retry)
                    .frame(maxWidth: 180)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Layout.pagePadding)
    }
}

#Preview {
    ErrorStateView(message: "Could not load data. Check your connection.") {}
}

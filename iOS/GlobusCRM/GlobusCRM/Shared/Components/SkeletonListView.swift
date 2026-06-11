import SwiftUI

// Generic skeleton list: shows N shimmer card-shaped placeholders while data is loading.
// Use when `!hasLoaded` to prevent the empty-state flash on first fetch.
struct SkeletonListView: View {
    var count: Int = 5
    var cardHeight: CGFloat = 72

    var body: some View {
        ScrollView {
            VStack(spacing: WellnessSpacing.sm) {
                ForEach(0..<count, id: \.self) { _ in
                    SkeletonCard(height: cardHeight)
                }
            }
            .padding(.horizontal, Layout.pagePadding)
            .padding(.vertical, WellnessSpacing.sm)
        }
        .allowsHitTesting(false)
    }
}

struct SkeletonCard: View {
    var height: CGFloat = 72

    var body: some View {
        HStack(spacing: WellnessSpacing.md) {
            Circle()
                .fill(Color.skeletonFill)
                .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.skeletonFill)
                    .frame(width: 160, height: 14)
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.skeletonFill)
                    .frame(width: 100, height: 12)
            }
            Spacer()
            RoundedRectangle(cornerRadius: 4)
                .fill(Color.skeletonFill)
                .frame(width: 60, height: 14)
        }
        .padding(Layout.cardPadding)
        .frame(maxWidth: .infinity, minHeight: height)
        .background(Color.wellnessSurface)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
        .shimmer()
    }
}

// MARK: - Shimmer modifier

private struct ShimmerModifier: ViewModifier {
    @State private var phase: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .overlay(
                LinearGradient(
                    gradient: Gradient(stops: [
                        .init(color: Color.clear, location: phase - 0.3),
                        .init(color: Color.white.opacity(0.45), location: phase),
                        .init(color: Color.clear, location: phase + 0.3)
                    ]),
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .allowsHitTesting(false)
            )
            .onAppear {
                withAnimation(.linear(duration: 1.5).repeatForever(autoreverses: false)) {
                    phase = 1.3
                }
            }
    }
}

extension View {
    func shimmer() -> some View {
        modifier(ShimmerModifier())
    }
}

// MARK: - Skeleton fill colour

private extension Color {
    // Neutral grey that sits naturally on .wellnessSurface without looking black
    static let skeletonFill = Color(UIColor.systemGray5)
}

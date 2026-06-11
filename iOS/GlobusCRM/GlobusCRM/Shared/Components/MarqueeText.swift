import SwiftUI

/// A single-line text view that loops (ticker-style) when content exceeds the available width.
/// Drop-in replacement for `Text(...).lineLimit(1)`.
/// Respects `accessibilityReduceMotion` — shows static truncated text when motion is reduced.
struct MarqueeText: View {
    let text: String
    var font: Font = .body
    var foregroundColor: Color = .primary
    /// Scroll speed in points per second.
    var speed: Double = 35
    /// Pause (seconds) before each loop begins.
    var pauseDuration: Double = 2.2

    @State private var textWidth: CGFloat = 0
    @State private var containerWidth: CGFloat = 0
    @State private var animating = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let gap: CGFloat = 48
    private var overflow: CGFloat { max(0, textWidth - containerWidth) }
    private var shouldScroll: Bool { overflow > 4 && !reduceMotion }
    private var loopDistance: CGFloat { textWidth + gap }
    private var duration: Double { loopDistance / speed }

    var body: some View {
        // Invisible spacer text: establishes correct row height; maxWidth fills container
        // so the background GeometryReader can measure available width.
        Text(text)
            .font(font)
            .lineLimit(1)
            .hidden()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                GeometryReader { proxy in
                    Color.clear.onAppear { containerWidth = proxy.size.width }
                }
            )
            // Hidden fixed-size copy for text-width measurement via PreferenceKey
            .overlay(alignment: .leading) {
                Text(text)
                    .font(font)
                    .fixedSize(horizontal: true, vertical: false)
                    .hidden()
                    .background(
                        GeometryReader { proxy in
                            Color.clear.preference(
                                key: MarqueeWidthKey.self,
                                value: proxy.size.width
                            )
                        }
                    )
            }
            .onPreferenceChange(MarqueeWidthKey.self) { w in
                textWidth = w
                animating = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    if shouldScroll { animating = true }
                }
            }
            // Visible content
            .overlay(alignment: .leading) {
                if shouldScroll {
                    // Two copies separated by `gap`; animate the pair continuously leftward.
                    // When the first copy scrolls exactly -(textWidth + gap), the second copy
                    // occupies the same position the first started — creating a seamless loop.
                    HStack(spacing: gap) {
                        Text(text)
                            .font(font)
                            .foregroundColor(foregroundColor)
                            .fixedSize(horizontal: true, vertical: false)
                        Text(text)
                            .font(font)
                            .foregroundColor(foregroundColor)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    .offset(x: animating ? -loopDistance : 0)
                    .animation(
                        animating
                            ? .linear(duration: duration)
                                .delay(pauseDuration)
                                .repeatForever(autoreverses: false)
                            : .none,
                        value: animating
                    )
                } else {
                    Text(text)
                        .font(font)
                        .foregroundColor(foregroundColor)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            // Trailing fade: gracefully indicates overflowing content
            .mask(
                HStack(spacing: 0) {
                    Rectangle()
                    LinearGradient(
                        colors: [.black, .clear],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: 16)
                }
            )
            .clipped()
    }
}

private struct MarqueeWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

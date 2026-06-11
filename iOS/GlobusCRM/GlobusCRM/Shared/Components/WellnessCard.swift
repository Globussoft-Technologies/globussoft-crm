import SwiftUI

// MARK: - Card view

struct WellnessCard<Content: View>: View {
    let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    var body: some View {
        content()
            .background(Color.wellnessSurface)
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
            .shadow(color: Color.black.opacity(0.06), radius: 8, x: 0, y: 2)
    }
}

// MARK: - Tappable card with press scale

struct InteractiveCard<Content: View>: View {
    let action: () -> Void
    let content: () -> Content

    init(action: @escaping () -> Void, @ViewBuilder content: @escaping () -> Content) {
        self.action = action
        self.content = content
    }

    var body: some View {
        Button(action: action) {
            WellnessCard(content: content)
                .contentShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
        }
        .buttonStyle(CardPressStyle())
    }
}

struct CardPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? AppAnimation.pressScale : 1)
            .animation(AppAnimation.spring, value: configuration.isPressed)
    }
}


#Preview {
    VStack(spacing: WellnessSpacing.lg) {
        WellnessCard { Text("Static card").padding() }
        InteractiveCard(action: {}) { Text("Tappable card").padding() }
    }
    .padding()
}

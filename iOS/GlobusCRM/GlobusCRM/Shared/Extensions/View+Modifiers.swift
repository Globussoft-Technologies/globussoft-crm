import SwiftUI

extension View {
    func wellnessCard() -> some View {
        self
            .background(Color.wellnessSurface)
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
            .shadow(color: Color.black.opacity(0.06), radius: 8, x: 0, y: 2)
    }

    func wellnessShadow(radius: CGFloat = 8) -> some View {
        self.shadow(color: Color.black.opacity(0.07), radius: radius, x: 0, y: 2)
    }

    func wellnessListBackground() -> some View {
        self.scrollContentBackground(.hidden)
            .background(Color.wellnessBackground)
    }

    func hideKeyboard() -> some View {
        self.onTapGesture {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                                            to: nil, from: nil, for: nil)
        }
    }
}

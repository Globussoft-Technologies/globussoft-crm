import SwiftUI

struct SplashScreenView: View {
    @State private var logoOpacity: Double = 0
    @State private var logoScale: Double = 0.85

    // Brand background color matches the system launch screen
    private let brandBackground = Color(
        red: 244.0 / 255.0,
        green: 246.0 / 255.0,
        blue: 251.0 / 255.0
    )

    var body: some View {
        ZStack {
            brandBackground.ignoresSafeArea()

            VStack(spacing: 0) {
                Image("SplashLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 220, height: 220)
                    .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
                    .opacity(logoOpacity)
                    .scaleEffect(logoScale)
            }
        }
        .onAppear {
            // Pop-in with a gentle spring
            withAnimation(.spring(response: 0.5, dampingFraction: 0.75)) {
                logoOpacity = 1
                logoScale = 1
            }

            // One-time subtle pulse after appearing
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) {
                withAnimation(.easeInOut(duration: 0.18)) {
                    logoScale = 1.03
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                    withAnimation(.easeOut(duration: 0.18)) {
                        logoScale = 1.0
                    }
                }
            }
        }
    }
}

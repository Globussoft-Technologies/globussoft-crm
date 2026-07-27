import SwiftUI

struct SplashScreenView: View {
    @State private var logoOpacity: Double = 0
    @State private var logoScale: Double = 0.85

    // Brand background color matches the supplied splash artwork.
    private let brandBackground = Color(
        red: 151.0 / 255.0,
        green: 154.0 / 255.0,
        blue: 132.0 / 255.0
    )

    var body: some View {
        ZStack {
            brandBackground.ignoresSafeArea()

            VStack(spacing: 0) {
                Image("WellnessSplashLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 480)
                    .padding(.horizontal, WellnessSpacing.lg)
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

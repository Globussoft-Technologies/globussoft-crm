import SwiftUI
import Combine

struct SplashView: View {
    @StateObject var viewModel: SplashViewModel
    @EnvironmentObject var sessionManager: SessionManager
    @EnvironmentObject var appState: AppState
    private let brandBackground = Color(
        red: 244.0 / 255.0,
        green: 246.0 / 255.0,
        blue: 251.0 / 255.0
    )
    
    var body: some View {
        ZStack {
            brandBackground.ignoresSafeArea()

            VStack(spacing: WellnessSpacing.lg) {
                Image("SplashLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 220, height: 220)
                    .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))

                ProgressView()
                    .tint(.white)
                    .padding(.top, WellnessSpacing.xl)
            }
            .padding(Layout.pagePadding)
        }
        .task { await viewModel.initialize() }
        .onReceive(viewModel.navSignal) { signal in
            switch signal {
            case .goToDashboard: sessionManager.setAuthenticated()
            case .goToLogin:     sessionManager.setUnauthenticated()
            }
        }
    }
}

enum SplashNavSignal {
    case goToDashboard
    case goToLogin
}

import SwiftUI

struct RootView: View {
    @EnvironmentObject var sessionManager: SessionManager
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var container: AppContainer
    @Environment(\.colorScheme) private var systemColorScheme

    var body: some View {
        Group {
            switch sessionManager.authState {
            case .unknown:
                SplashView(viewModel: container.authContainer.splashViewModel)

            case .unauthenticated:
                NavigationStack(path: $router.authPath) {
                    LoginView(viewModel: container.authContainer.loginViewModel)
                        .navigationDestination(for: AppRoute.self) { route in
                            switch route {
                            case .register:
                                RegisterView(viewModel: container.authContainer.registerViewModel)
                            default:
                                EmptyView()
                            }
                        }
                }

            case .authenticated:
                MainTabView()
                    .onOpenURL { url in
                        if let route = DeepLinkHandler.resolve(url: url) {
                            router.navigate(to: route)
                        }
                    }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .handleDeepLink)) { notification in
            guard let url = notification.object as? URL,
                  let route = DeepLinkHandler.resolve(url: url) else { return }
            router.navigate(to: route)
        }
        .environment(\.wellnessTheme, WellnessThemeEnvironment(
            primaryColor: appState.brandColor,
            isDarkMode: appState.resolvedIsDark(systemColorScheme: systemColorScheme)
        ))
        .preferredColorScheme(appState.preferredColorScheme)
    }
}

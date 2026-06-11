import SwiftUI
import Combine

struct LoginView: View {
    @StateObject var viewModel: LoginViewModel
    @EnvironmentObject var sessionManager: SessionManager
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var router: AppRouter

    var body: some View {
        ScrollView {
            VStack(spacing: WellnessSpacing.xxl) {
                headerSection
                formSection
                footerSection
            }
            .padding(Layout.pagePadding)
            .padding(.bottom, WellnessSpacing.xxl)
        }
        .background(Color.wellnessBackground)
        .scrollDismissesKeyboard(.interactively)
        .navigationBarHidden(true)
        .onReceive(viewModel.navSignal) { signal in
            switch signal {
            case .navigateToDashboard: sessionManager.setAuthenticated()
            case .navigateToRegister:  router.navigate(to: .register)
            }
        }
    }

    // MARK: Header

    private var headerSection: some View {
        VStack(spacing: WellnessSpacing.md) {
            AsyncImage(url: URL(string: appState.logoUrl ?? "")) { image in
                image.resizable().scaledToFit()
            } placeholder: {
                Image(systemName: Symbols.clinic)
                    .font(.system(size: IconSize.hero))
                    .foregroundColor(appState.brandColor)
            }
            .frame(height: 72)
            .padding(.top, WellnessSpacing.xxl)

            Text(appState.clinicName)
                .font(.wellnessLargeTitle)
                .foregroundColor(.wellnessOnSurface)
                .multilineTextAlignment(.center)

            Text("Patient Portal")
                .font(.wellnessBody)
                .foregroundColor(.wellnessMuted)
        }
    }

    // MARK: Form

    private var formSection: some View {
        VStack(spacing: WellnessSpacing.lg) {
            errorBanner

            WellnessTextField(
                label: "Email",
                placeholder: "you@example.com",
                text: Binding(
                    get: { viewModel.uiState.email },
                    set: { viewModel.onEvent(.emailChanged($0)) }
                ),
                keyboardType: .emailAddress,
                submitLabel: .next
            )

            WellnessTextField(
                label: "Password",
                placeholder: "••••••••",
                text: Binding(
                    get: { viewModel.uiState.password },
                    set: { viewModel.onEvent(.passwordChanged($0)) }
                ),
                isSecure: true,
                submitLabel: .go
            )

            WellnessButton(
                "Sign In",
                isLoading: viewModel.uiState.isLoading
            ) {
                viewModel.onEvent(.submit)
            }
        }
    }

    @ViewBuilder
    private var errorBanner: some View {
        if let error = viewModel.uiState.error {
            Label(error, systemImage: Symbols.errorTriangle)
                .font(.wellnessCaption)
                .foregroundColor(.wellnessError)
                .padding(WellnessSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.wellnessError.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
                .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    // MARK: Footer

    private var footerSection: some View {
        HStack(spacing: WellnessSpacing.xs) {
            Text("Don't have an account?")
                .font(.wellnessBody)
                .foregroundColor(.wellnessMuted)
            Button("Register") {
                viewModel.onEvent(.navigateToRegister)
            }
            .font(.wellnessBody)
            .fontWeight(.semibold)
            .foregroundColor(appState.brandColor)
            .accessibilityLabel("Register for a new account")
        }
    }
}

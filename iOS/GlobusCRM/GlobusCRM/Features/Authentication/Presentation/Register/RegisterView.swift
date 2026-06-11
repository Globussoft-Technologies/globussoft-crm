import SwiftUI
import Combine

struct RegisterView: View {
    @StateObject var viewModel: RegisterViewModel
    @EnvironmentObject var sessionManager: SessionManager
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var router: AppRouter

    var body: some View {
        ScrollView {
            VStack(spacing: WellnessSpacing.xl) {
                Text("Create Account")
                    .font(.wellnessTitle)
                    .foregroundColor(.wellnessOnSurface)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, WellnessSpacing.xl)

                errorBanner

                WellnessTextField(
                    label: "Full Name",
                    placeholder: "Jane Smith",
                    text: Binding(
                        get: { viewModel.uiState.name },
                        set: { viewModel.onEvent(.nameChanged($0)) }
                    ),
                    submitLabel: .next
                )

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
                    placeholder: "Min. 8 characters",
                    text: Binding(
                        get: { viewModel.uiState.password },
                        set: { viewModel.onEvent(.passwordChanged($0)) }
                    ),
                    isSecure: true,
                    submitLabel: .next
                )

                WellnessTextField(
                    label: "Confirm Password",
                    placeholder: "Re-enter password",
                    text: Binding(
                        get: { viewModel.uiState.confirmPassword },
                        set: { viewModel.onEvent(.confirmPasswordChanged($0)) }
                    ),
                    isSecure: true,
                    submitLabel: .go
                )

                WellnessButton(
                    "Create Account",
                    isLoading: viewModel.uiState.isLoading
                ) {
                    viewModel.onEvent(.submit)
                }

                Button("Already have an account? Sign in") {
                    viewModel.onEvent(.navigateToLogin)
                }
                .font(.wellnessBody)
                .fontWeight(.semibold)
                .foregroundColor(appState.brandColor)
                .accessibilityLabel("Sign in to existing account")
            }
            .padding(Layout.pagePadding)
            .padding(.bottom, WellnessSpacing.xxl)
        }
        .background(Color.wellnessBackground)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Register")
        .navigationBarTitleDisplayMode(.inline)
        .onReceive(viewModel.navSignal) { signal in
            switch signal {
            case .navigateToDashboard: sessionManager.setAuthenticated()
            case .navigateBack:        router.pop()
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
}

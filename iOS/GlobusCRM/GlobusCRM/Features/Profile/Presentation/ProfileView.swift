import SwiftUI
import PhotosUI

struct ProfileView: View {
    @StateObject var viewModel: ProfileViewModel
    @EnvironmentObject var router: AppRouter

    @State private var exportRequested = false
    @State private var showSuccessToast = false
    @State private var showSignOutAlert = false
    @State private var showDeleteAccountAlert = false
    @State private var showDeleteAccountSheet = false

    var body: some View {
        ScrollView {
            VStack(spacing: WellnessSpacing.lg) {
                avatarCard

                if viewModel.isEditing {
                    editProfileCard
                } else {
                    accountDetailsCard
                }

                ChangePasswordCard(viewModel: viewModel)

                notificationRow

                privacyCard

                signOutButton
            }
            .padding(.horizontal, Layout.pagePadding)
            .padding(.vertical, WellnessSpacing.lg)
        }
        .background(Color.wellnessBackground.ignoresSafeArea())
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.load() }
        .overlay { if viewModel.isLoading { LoadingView() } }
        .onChange(of: viewModel.successMessage) { msg in
            if msg != nil {
                showSuccessToast = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                    showSuccessToast = false
                    viewModel.successMessage = nil
                }
            }
        }
        .overlay(alignment: .bottom) {
            if showSuccessToast, let msg = viewModel.successMessage {
                ToastBanner(message: msg)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .animation(.spring(response: 0.3), value: showSuccessToast)
                    .padding(.bottom, 24)
            }
        }
        .alert("Delete Account", isPresented: $showDeleteAccountAlert) {
            Button("Cancel", role: .cancel) { }
            Button("Continue", role: .destructive) {
                showDeleteAccountSheet = true
            }
        } message: {
            Text("This will permanently delete your account and all your data. This action cannot be undone.")
        }
        .sheet(isPresented: $showDeleteAccountSheet) {
            DeleteAccountSheet(viewModel: viewModel, isPresented: $showDeleteAccountSheet)
        }
    }

    // MARK: - Avatar Card

    private var avatarCard: some View {
        VStack(spacing: WellnessSpacing.md) {
            ZStack(alignment: .bottomTrailing) {
                Group {
                    if let img = viewModel.avatarImage {
                        img.resizable().scaledToFill()
                    } else {
                        Circle()
                            .fill(Color.wellnessTeal.opacity(0.1))
                            .overlay(
                                Image(systemName: "person.fill")
                                    .font(.system(size: IconSize.large))
                                    .foregroundColor(.wellnessTeal.opacity(0.5))
                            )
                    }
                }
                .frame(width: 88, height: 88)
                .clipShape(Circle())
                .overlay(Circle().stroke(Color.wellnessTeal.opacity(0.2), lineWidth: 2))

                PhotosPicker(selection: $viewModel.selectedPhotoItem, matching: .images) {
                    ZStack {
                        Circle()
                            .fill(Color.wellnessTeal)
                            .frame(width: 28, height: 28)
                        Image(systemName: "camera.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundColor(.white)
                    }
                }
                .offset(x: 2, y: 2)
            }

            if viewModel.profile?.avatarUrl != nil || viewModel.avatarImage != nil {
                Button {
                    Task { await viewModel.removeAvatar() }
                } label: {
                    Text("Remove picture")
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessError)
                }
                .buttonStyle(.plain)
            }

            if let profile = viewModel.profile {
                VStack(spacing: WellnessSpacing.xs) {
                    Text(profile.name)
                        .font(.wellnessTitle3)
                        .foregroundColor(.wellnessOnSurface)
                    Text(profile.email)
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessMuted)
                }
            }

            Text("CUSTOMER")
                .font(.wellnessCaption2)
                .fontWeight(.semibold)
                .tracking(0.8)
                .foregroundColor(.wellnessTeal)
                .padding(.horizontal, WellnessSpacing.md)
                .padding(.vertical, WellnessSpacing.xs)
                .background(Color.wellnessTeal.opacity(0.12))
                .clipShape(Capsule())
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Layout.cardPaddingLarge)
        .background(Color.wellnessSurface)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
        .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
    }

    // MARK: - Account Details Card (view mode)

    private var accountDetailsCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Account Details")
                .font(.wellnessCallout)
                .fontWeight(.semibold)
                .foregroundColor(.wellnessOnSurface)
                .padding(.horizontal, Layout.cardPadding)
                .padding(.top, Layout.cardPadding)
                .padding(.bottom, WellnessSpacing.sm)

            if let profile = viewModel.profile {
                ProfileDetailRow(label: "Name", value: profile.name)
                Divider().padding(.leading, Layout.cardPadding)
                ProfileDetailRow(label: "Phone", value: profile.phone)
                Divider().padding(.leading, Layout.cardPadding)
                ProfileDetailRow(label: "Email", value: profile.email)
                if let dob = profile.dateOfBirth, !dob.isEmpty {
                    Divider().padding(.leading, Layout.cardPadding)
                    ProfileDetailRow(label: "Date of Birth", value: DateUtil.formatDate(iso: dob))
                }
                if let gender = profile.gender, !gender.isEmpty {
                    Divider().padding(.leading, Layout.cardPadding)
                    ProfileDetailRow(label: "Gender", value: displayGender(gender))
                }
            }

            Divider()

            Button { viewModel.startEditing() } label: {
                Text("Edit profile")
                    .font(.wellnessCallout)
                    .fontWeight(.medium)
                    .foregroundColor(.wellnessTeal)
                    .frame(maxWidth: .infinity)
                    .frame(height: Layout.minTapTarget)
            }
            .buttonStyle(.plain)
        }
        .background(Color.wellnessSurface)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
        .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
    }

    // MARK: - Edit Profile Card (edit mode)

    private var editProfileCard: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.lg) {
            Text("Edit Profile")
                .font(.wellnessCallout)
                .fontWeight(.semibold)
                .foregroundColor(.wellnessOnSurface)

            if let binding = Binding($viewModel.editedProfile) {
                WellnessTextField(
                    label: "Full Name",
                    placeholder: "Your full name",
                    text: binding.name
                )
                WellnessTextField(
                    label: "Email",
                    placeholder: "email@example.com",
                    text: binding.email,
                    keyboardType: .emailAddress,
                    autocapitalization: .never
                )
            }

            HStack(alignment: .top, spacing: WellnessSpacing.xs) {
                Image(systemName: "info.circle")
                    .font(.caption)
                    .foregroundColor(.wellnessMuted)
                Text("Phone, date of birth and gender can only be updated at the clinic.")
                    .font(.wellnessCaption)
                    .foregroundColor(.wellnessMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let error = viewModel.error {
                Label(error, systemImage: Symbols.errorTriangle)
                    .font(.wellnessCaption)
                    .foregroundColor(.wellnessError)
            }

            HStack(spacing: WellnessSpacing.md) {
                Button { viewModel.cancelEditing() } label: {
                    Text("Cancel")
                        .font(.wellnessCallout)
                        .fontWeight(.medium)
                        .foregroundColor(.wellnessMuted)
                        .frame(maxWidth: .infinity)
                        .frame(height: Layout.minTapTarget)
                        .background(Color.wellnessMuted.opacity(0.1))
                        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
                }
                .buttonStyle(.plain)

                WellnessButton("Save", isLoading: viewModel.isSaving) {
                    Task { await viewModel.saveProfile() }
                }
            }
        }
        .padding(Layout.cardPadding)
        .background(Color.wellnessSurface)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
        .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
    }

    // MARK: - Notification Row

    private var notificationRow: some View {
        Button { router.navigate(to: .notificationSettings) } label: {
            HStack(spacing: WellnessSpacing.md) {
                RoundedRectangle(cornerRadius: WellnessRadius.small)
                    .fill(Color.wellnessTeal.opacity(0.1))
                    .frame(width: 36, height: 36)
                    .overlay(
                        Image(systemName: Symbols.bell)
                            .font(.system(size: IconSize.badge))
                            .foregroundColor(.wellnessTeal)
                    )
                Text("Notification Settings")
                    .font(.wellnessBody)
                    .foregroundColor(.wellnessOnSurface)
                Spacer()
                Image(systemName: Symbols.chevronRight)
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.wellnessMuted)
            }
            .padding(Layout.cardPadding)
            .background(Color.wellnessSurface)
            .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
            .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Privacy Card

    private var privacyCard: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.md) {
            Text("Data & Privacy")
                .font(.wellnessCallout)
                .fontWeight(.semibold)
                .foregroundColor(.wellnessOnSurface)

            if exportRequested {
                HStack(spacing: WellnessSpacing.sm) {
                    Image(systemName: Symbols.checkmarkCircle)
                        .foregroundColor(.wellnessTeal)
                    VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                        Text("Export request submitted")
                            .font(.wellnessCaption)
                            .fontWeight(.medium)
                            .foregroundColor(.wellnessOnSurface)
                        Text("You'll receive an email within 72 hours.")
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessMuted)
                    }
                    Spacer()
                }
                .padding(WellnessSpacing.md)
                .background(Color.wellnessTeal.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
            } else {
                WellnessButton("Request Data Export", style: .secondary) {
                    Task {
                        await viewModel.requestDataExport()
                        exportRequested = true
                    }
                }
            }

            Divider()

            Button {
                showDeleteAccountAlert = true
            } label: {
                Text("Delete Account")
                    .font(.wellnessCallout)
                    .fontWeight(.medium)
                    .foregroundColor(.wellnessError)
                    .frame(maxWidth: .infinity)
                    .frame(height: Layout.minTapTarget)
            }
            .buttonStyle(.plain)
        }
        .padding(Layout.cardPadding)
        .background(Color.wellnessSurface)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
        .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
    }

    // MARK: - Sign Out

    private var signOutButton: some View {
        Button {
            showSignOutAlert = true
        } label: {
            Text("Sign Out")
                .font(.wellnessCallout)
                .fontWeight(.medium)
                .foregroundColor(.wellnessError)
                .frame(maxWidth: .infinity)
                .frame(height: Layout.minTapTarget)
        }
        .buttonStyle(.plain)
        .alert("Sign Out", isPresented: $showSignOutAlert) {
            Button("Sign Out", role: .destructive) {
                Task {
                    await viewModel.logout()
                }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Are you sure you want to sign out?")
        }
    }

    // MARK: - Helpers

    private func displayGender(_ raw: String) -> String {
        switch raw.uppercased() {
        case "F", "FEMALE": return "Female"
        case "M", "MALE":   return "Male"
        default:            return raw
        }
    }
}

// MARK: - Delete Account Sheet

struct DeleteAccountSheet: View {
    @ObservedObject var viewModel: ProfileViewModel
    @Binding var isPresented: Bool

    @State private var password = ""
    @State private var twoFACode = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: WellnessSpacing.md) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: IconSize.large))
                            .foregroundColor(.wellnessError)
                        Text("Permanent Deletion")
                            .font(.wellnessSubheadline)
                            .fontWeight(.semibold)
                            .foregroundColor(.wellnessOnSurface)
                        Text("All your appointments, medical records, wallet balance, and personal data will be permanently and irreversibly deleted.")
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessMuted)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, WellnessSpacing.sm)
                }

                Section("Confirm your identity") {
                    SecureField("Current password", text: $password)
                    TextField("2FA code (if enabled)", text: $twoFACode)
                        .keyboardType(.numberPad)
                }

                if let error = viewModel.error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessError)
                    }
                }
            }
            .navigationTitle("Delete Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        viewModel.error = nil
                        isPresented = false
                    }
                    .disabled(viewModel.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if viewModel.isSaving {
                        ProgressView()
                    } else {
                        Button("Delete") {
                            Task {
                                await viewModel.deleteAccount(
                                    password: password,
                                    code: twoFACode.isEmpty ? nil : twoFACode
                                )
                            }
                        }
                        .foregroundColor(.wellnessError)
                        .disabled(password.isEmpty)
                    }
                }
            }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(viewModel.isSaving)
    }
}

// MARK: - Profile Detail Row (fixed-width label column for form-like grid alignment)

private struct ProfileDetailRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .font(.wellnessCaption)
                .foregroundColor(.wellnessMuted)
                .frame(width: 110, alignment: .leading)
            Text(value)
                .font(.wellnessBody)
                .foregroundColor(.wellnessOnSurface)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .multilineTextAlignment(.trailing)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .truncationMode(.middle)
        }
        .padding(.horizontal, Layout.cardPadding)
        .padding(.vertical, WellnessSpacing.md)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }
}

// MARK: - Change Password Card

struct ChangePasswordCard: View {
    @ObservedObject var viewModel: ProfileViewModel
    @State private var current = ""
    @State private var newPass = ""
    @State private var confirmPass = ""
    @State private var succeeded = false

    var body: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.lg) {
            Text("Change Password")
                .font(.wellnessCallout)
                .fontWeight(.semibold)
                .foregroundColor(.wellnessOnSurface)

            if succeeded {
                HStack(spacing: WellnessSpacing.sm) {
                    Image(systemName: Symbols.checkmarkCircle)
                        .foregroundColor(.wellnessTeal)
                    Text("Password changed successfully.")
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessOnSurface)
                    Spacer()
                }
                .padding(WellnessSpacing.md)
                .background(Color.wellnessTeal.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
            } else {
                WellnessTextField(
                    label: "Current Password",
                    placeholder: "Enter current password",
                    text: $current,
                    isSecure: true
                )
                WellnessTextField(
                    label: "New Password",
                    placeholder: "Min. 8 characters",
                    text: $newPass,
                    isSecure: true
                )
                WellnessTextField(
                    label: "Confirm New Password",
                    placeholder: "Re-enter new password",
                    text: $confirmPass,
                    isSecure: true
                )

                if let error = viewModel.error, viewModel.showChangePassword {
                    Label(error, systemImage: Symbols.errorTriangle)
                        .font(.wellnessCaption)
                        .foregroundColor(.wellnessError)
                }

                WellnessButton(
                    "Change Password",
                    style: .secondary,
                    isLoading: viewModel.isSaving
                ) {
                    viewModel.showChangePassword = true
                    Task {
                        await viewModel.changePassword(current: current, new: newPass, confirm: confirmPass)
                        if viewModel.error == nil {
                            succeeded = true
                            current = ""; newPass = ""; confirmPass = ""
                        }
                    }
                }
                .disabled(current.isEmpty || newPass.isEmpty || confirmPass.isEmpty)
            }
        }
        .padding(Layout.cardPadding)
        .background(Color.wellnessSurface)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
        .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
    }
}

// MARK: - Toast Banner

private struct ToastBanner: View {
    let message: String

    var body: some View {
        HStack(spacing: WellnessSpacing.sm) {
            Image(systemName: Symbols.checkmarkCircle)
                .foregroundColor(.wellnessTeal)
            Text(message)
                .font(.wellnessCaption)
                .foregroundColor(.wellnessOnSurface)
                .lineLimit(2)
        }
        .padding(.horizontal, WellnessSpacing.lg)
        .padding(.vertical, WellnessSpacing.md)
        .background(Color.wellnessSurface)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.full))
        .shadow(color: .black.opacity(0.12), radius: 12, x: 0, y: 4)
    }
}

// MARK: - Binding Optional Helper

private extension Binding where Value == PatientProfile? {
    func toNonOptionalBinding(default defaultValue: String) -> Binding<String> {
        Binding<String>(
            get: { self.wrappedValue?.name ?? defaultValue },
            set: { _ in }
        )
    }
}

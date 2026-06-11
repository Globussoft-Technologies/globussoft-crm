import Foundation

// MARK: - Auth

final class AuthFeatureContainer {
    private unowned let c: AppContainer

    init(container: AppContainer) { self.c = container }

    lazy var authRepository: AuthRepository = AuthRepositoryImpl(
        apiClient: c.apiClient,
        keychainManager: c.keychainManager,
        userDefaultsManager: c.userDefaultsManager
    )

    lazy var loginViewModel: LoginViewModel = LoginViewModel(
        loginUseCase: LoginUseCase(repository: authRepository),
        getTenantBrandingUseCase: GetTenantBrandingUseCase(repository: authRepository),
        getPermissionsUseCase: GetPatientPermissionsUseCase(repository: authRepository),
        appState: c.appState
    )

    lazy var registerViewModel: RegisterViewModel = RegisterViewModel(
        registerUseCase: RegisterUseCase(repository: authRepository),
        getPermissionsUseCase: GetPatientPermissionsUseCase(repository: authRepository),
        appState: c.appState
    )

    lazy var splashViewModel: SplashViewModel = SplashViewModel(
        checkAuthStatusUseCase: CheckAuthStatusUseCase(repository: authRepository),
        getTenantBrandingUseCase: GetTenantBrandingUseCase(repository: authRepository),
        getPermissionsUseCase: GetPatientPermissionsUseCase(repository: authRepository),
        fetchPatientIdUseCase: FetchPatientIdUseCase(repository: authRepository),
        appState: c.appState
    )
}

// MARK: - Dashboard

final class DashboardFeatureContainer {
    private unowned let c: AppContainer

    init(container: AppContainer) { self.c = container }

    lazy var dashboardRepository: DashboardRepository = DashboardRepositoryImpl(
        apiClient: c.apiClient,
        keychainManager: c.keychainManager
    )

    lazy var dashboardViewModel: DashboardViewModel = DashboardViewModel(
        getDashboardSummaryUseCase: GetDashboardSummaryUseCase(repository: dashboardRepository),
        keychainManager: c.keychainManager
    )
}

// MARK: - Booking

final class BookingFeatureContainer {
    private unowned let c: AppContainer

    init(container: AppContainer) { self.c = container }

    lazy var appointmentRepository: AppointmentRepository = AppointmentRepositoryImpl(
        apiClient: c.apiClient,
        keychainManager: c.keychainManager
    )

    lazy var myAppointmentsViewModel: MyAppointmentsViewModel = MyAppointmentsViewModel(
        getMyAppointmentsUseCase: GetMyAppointmentsUseCase(repository: appointmentRepository),
        cancelUseCase: CancelAppointmentUseCase(repository: appointmentRepository),
        rescheduleUseCase: RescheduleAppointmentUseCase(repository: appointmentRepository)
    )

    lazy var bookAppointmentViewModel: BookAppointmentViewModel = BookAppointmentViewModel(
        bookUseCase: BookAppointmentUseCase(repository: appointmentRepository),
        repository: appointmentRepository
    )

    lazy var visitHistoryViewModel: VisitHistoryViewModel = VisitHistoryViewModel(
        getVisitHistoryUseCase: GetVisitHistoryUseCase(repository: appointmentRepository)
    )

    lazy var waitlistViewModel: WaitlistViewModel = WaitlistViewModel(
        getWaitlistUseCase: GetWaitlistUseCase(repository: appointmentRepository),
        addToWaitlistUseCase: AddToWaitlistUseCase(repository: appointmentRepository, keychainManager: c.keychainManager),
        repository: appointmentRepository
    )
}

// MARK: - Health

final class HealthFeatureContainer {
    private unowned let c: AppContainer

    init(container: AppContainer) { self.c = container }

    lazy var healthRepository: HealthRepository = HealthRepositoryImpl(
        apiClient: c.apiClient,
        keychain: c.keychainManager
    )

    lazy var prescriptionsViewModel: PrescriptionsViewModel = PrescriptionsViewModel(
        getPrescriptionsUseCase: GetPrescriptionsUseCase(repository: healthRepository),
        getPrescriptionPdfUseCase: GetPrescriptionPdfUseCase(repository: healthRepository),
        keychain: c.keychainManager,
        appState: c.appState
    )

    lazy var treatmentPlansViewModel: TreatmentPlansViewModel = TreatmentPlansViewModel(
        getTreatmentPlansUseCase: GetTreatmentPlansUseCase(repository: healthRepository),
        keychain: c.keychainManager
    )

    lazy var consentFormsViewModel: ConsentFormsViewModel = ConsentFormsViewModel(
        getConsentFormsUseCase: GetConsentFormsUseCase(repository: healthRepository),
        keychain: c.keychainManager
    )
}

// MARK: - Membership

final class MembershipFeatureContainer {
    private unowned let c: AppContainer

    init(container: AppContainer) { self.c = container }

    lazy var membershipRepository: MembershipRepository = MembershipRepositoryImpl(
        apiClient: c.apiClient
    )

    lazy var membershipViewModel: MembershipViewModel = MembershipViewModel(
        getAvailablePlansUseCase: GetAvailablePlansUseCase(repository: membershipRepository),
        getMyMembershipsUseCase: GetMyMembershipsUseCase(repository: membershipRepository),
        joinMembershipUseCase: JoinMembershipUseCase(repository: membershipRepository),
        keychain: c.keychainManager
    )
}

// MARK: - Wallet

final class WalletFeatureContainer {
    private unowned let c: AppContainer

    init(container: AppContainer) { self.c = container }

    lazy var walletRepository: WalletRepository = WalletRepositoryImpl(
        apiClient: c.apiClient
    )

    lazy var walletViewModel: WalletViewModel = WalletViewModel(
        getWalletUseCase: GetWalletUseCase(repository: walletRepository),
        keychain: c.keychainManager
    )

    lazy var giftCardsViewModel: GiftCardsViewModel = GiftCardsViewModel(
        getStorefrontUseCase: GetGiftCardStorefrontUseCase(repository: walletRepository),
        getGiftCardsUseCase: GetGiftCardsUseCase(repository: walletRepository),
        redeemGiftCardUseCase: RedeemGiftCardUseCase(repository: walletRepository),
        keychain: c.keychainManager
    )
}

// MARK: - Finance

final class FinanceFeatureContainer {
    private unowned let c: AppContainer

    init(container: AppContainer) { self.c = container }

    lazy var financeRepository: FinanceRepository = FinanceRepositoryImpl(
        apiClient: c.apiClient
    )

    lazy var paymentsViewModel: PaymentsViewModel = PaymentsViewModel(
        getPaymentsUseCase: GetPaymentsUseCase(repository: financeRepository),
        refundPaymentUseCase: RefundPaymentUseCase(repository: financeRepository)
    )
}

// MARK: - Catalog

final class CatalogFeatureContainer {
    private unowned let c: AppContainer

    init(container: AppContainer) { self.c = container }

    lazy var catalogRepository: CatalogRepository = CatalogRepositoryImpl(
        apiClient: c.apiClient
    )

    lazy var catalogViewModel: CatalogViewModel = CatalogViewModel(
        getServicesUseCase: GetServicesUseCase(repository: catalogRepository),
        getCategoriesUseCase: GetCategoriesUseCase(repository: catalogRepository)
    )
}

// MARK: - Loyalty

final class LoyaltyFeatureContainer {
    private unowned let c: AppContainer

    init(container: AppContainer) { self.c = container }

    lazy var loyaltyRepository: LoyaltyRepository = LoyaltyRepositoryImpl(
        apiClient: c.apiClient
    )

    lazy var loyaltyViewModel: LoyaltyViewModel = LoyaltyViewModel(
        getLoyaltyUseCase: GetLoyaltyUseCase(repository: loyaltyRepository),
        keychain: c.keychainManager
    )
}

// MARK: - Profile

final class ProfileFeatureContainer {
    private unowned let c: AppContainer

    init(container: AppContainer) { self.c = container }

    lazy var profileRepository: ProfileRepository = ProfileRepositoryImpl(
        apiClient: c.apiClient,
        keychain: c.keychainManager
    )

    lazy var profileViewModel: ProfileViewModel = ProfileViewModel(
        getProfileUseCase: GetProfileUseCase(repository: profileRepository),
        getAuthProfileUseCase: GetAuthProfileUseCase(repository: profileRepository),
        updateProfileUseCase: UpdateProfileUseCase(repository: profileRepository),
        updateAvatarUseCase: UpdateAvatarUseCase(repository: profileRepository),
        removeAvatarUseCase: RemoveAvatarUseCase(repository: profileRepository),
        changePasswordUseCase: ChangePasswordUseCase(repository: profileRepository),
        requestDataExportUseCase: RequestDataExportUseCase(repository: profileRepository),
        requestAccountDeletionUseCase: RequestAccountDeletionUseCase(repository: profileRepository),
        keychain: c.keychainManager
    )

    lazy var notificationSettingsViewModel: NotificationSettingsViewModel = NotificationSettingsViewModel()
}

// MARK: - Notifications

final class NotificationsFeatureContainer {
    private unowned let c: AppContainer

    init(container: AppContainer) { self.c = container }

    lazy var notificationDAO = NotificationDAO()

    lazy var notificationRepository: NotificationRepository = NotificationRepositoryImpl(
        apiClient: c.apiClient
    )

    lazy var notificationInboxViewModel: NotificationInboxViewModel = NotificationInboxViewModel(
        dao: notificationDAO,
        appState: c.appState,
        getNotificationsUseCase: GetNotificationsUseCase(repository: notificationRepository),
        markReadUseCase: MarkNotificationReadUseCase(repository: notificationRepository),
        markAllReadUseCase: MarkAllNotificationsReadUseCase(repository: notificationRepository)
    )
}

package com.globus.crm.core.navigation

import android.content.Intent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.NavType
import androidx.navigation.navArgument
import androidx.navigation.navDeepLink
import com.globus.crm.feature.auth.presentation.screen.LoginScreen
import com.globus.crm.feature.auth.presentation.screen.RegisterScreen
import com.globus.crm.feature.auth.presentation.screen.SplashScreen
import com.globus.crm.feature.auth.presentation.viewmodel.LoginNavEvent
import com.globus.crm.feature.auth.presentation.viewmodel.LoginViewModel
import com.globus.crm.feature.auth.presentation.viewmodel.RegisterNavEvent
import com.globus.crm.feature.auth.presentation.viewmodel.RegisterViewModel
import com.globus.crm.feature.auth.presentation.viewmodel.SplashNavEvent
import com.globus.crm.feature.auth.presentation.viewmodel.SplashViewModel
import com.globus.crm.feature.booking.presentation.screen.BookAppointmentScreen
import com.globus.crm.feature.booking.presentation.screen.MyAppointmentsScreen
import com.globus.crm.feature.booking.presentation.screen.VisitHistoryScreen
import com.globus.crm.feature.booking.presentation.viewmodel.BookAppointmentNavEvent
import com.globus.crm.feature.booking.presentation.viewmodel.BookAppointmentViewModel
import com.globus.crm.feature.booking.presentation.viewmodel.MyAppointmentsNavEvent
import com.globus.crm.feature.booking.presentation.viewmodel.MyAppointmentsViewModel
import com.globus.crm.feature.booking.presentation.screen.WaitlistScreen
import com.globus.crm.feature.booking.presentation.viewmodel.VisitHistoryNavEvent
import com.globus.crm.feature.booking.presentation.viewmodel.VisitHistoryViewModel
import com.globus.crm.feature.booking.presentation.viewmodel.WaitlistNavEvent
import com.globus.crm.feature.booking.presentation.viewmodel.WaitlistViewModel
import com.globus.crm.feature.dashboard.presentation.screen.DashboardScreen
import com.globus.crm.feature.dashboard.presentation.viewmodel.DashboardNavEvent
import com.globus.crm.feature.dashboard.presentation.viewmodel.DashboardViewModel
import com.globus.crm.feature.health.presentation.screen.ConsentFormPdfScreen
import com.globus.crm.feature.health.presentation.screen.ConsentFormsScreen
import com.globus.crm.feature.health.presentation.screen.PrescriptionPdfScreen
import com.globus.crm.feature.health.presentation.screen.PrescriptionsScreen
import com.globus.crm.feature.health.presentation.screen.TreatmentPlansScreen
import com.globus.crm.feature.health.presentation.viewmodel.ConsentFormPdfNavEvent
import com.globus.crm.feature.health.presentation.viewmodel.ConsentFormPdfViewModel
import com.globus.crm.feature.health.presentation.viewmodel.ConsentFormsNavEvent
import com.globus.crm.feature.health.presentation.viewmodel.ConsentFormsViewModel
import com.globus.crm.feature.health.presentation.viewmodel.PrescriptionPdfNavEvent
import com.globus.crm.feature.health.presentation.viewmodel.PrescriptionPdfViewModel
import com.globus.crm.feature.health.presentation.viewmodel.PrescriptionsNavEvent
import com.globus.crm.feature.health.presentation.viewmodel.PrescriptionsViewModel
import com.globus.crm.feature.health.presentation.viewmodel.TreatmentPlansNavEvent
import com.globus.crm.feature.health.presentation.viewmodel.TreatmentPlansViewModel
import com.globus.crm.feature.catalog.presentation.screen.CatalogTabScreen
import com.globus.crm.feature.finance.presentation.screen.FinanceTabScreen
import com.globus.crm.feature.finance.presentation.viewmodel.FinanceNavEvent
import com.globus.crm.feature.finance.presentation.viewmodel.FinanceViewModel
import com.globus.crm.feature.notifications.presentation.screen.NotificationSettingsScreen
import com.globus.crm.feature.catalog.presentation.viewmodel.CatalogNavEvent
import com.globus.crm.feature.catalog.presentation.viewmodel.CatalogViewModel
import com.globus.crm.feature.loyalty.presentation.screen.LoyaltyScreen
import com.globus.crm.feature.loyalty.presentation.viewmodel.LoyaltyNavEvent
import com.globus.crm.feature.loyalty.presentation.viewmodel.LoyaltyViewModel
import com.globus.crm.feature.membership.presentation.screen.InlineMembershipsTab
import com.globus.crm.feature.membership.presentation.screen.MembershipsScreen
import com.globus.crm.feature.membership.presentation.viewmodel.MembershipsNavEvent
import com.globus.crm.feature.membership.presentation.viewmodel.MembershipsViewModel
import com.globus.crm.feature.notifications.presentation.screen.NotificationInboxScreen
import com.globus.crm.feature.notifications.presentation.viewmodel.NotificationsNavEvent
import com.globus.crm.feature.notifications.presentation.viewmodel.NotificationsViewModel
import com.globus.crm.feature.profile.presentation.screen.ProfileScreen
import com.globus.crm.feature.profile.presentation.viewmodel.ProfileNavEvent
import com.globus.crm.feature.profile.presentation.viewmodel.ProfileViewModel
import com.globus.crm.feature.wallet.presentation.screen.GiftCardsScreen
import com.globus.crm.feature.wallet.presentation.screen.WalletScreen
import com.globus.crm.feature.wallet.presentation.viewmodel.GiftCardsNavEvent
import com.globus.crm.feature.wallet.presentation.viewmodel.GiftCardsViewModel
import com.globus.crm.feature.wallet.presentation.viewmodel.WalletNavEvent
import com.globus.crm.feature.wallet.presentation.viewmodel.WalletViewModel

private val AUTH_ROUTES = setOf(Screen.Splash.route, Screen.Login.route, Screen.Register.route)

private val TAB_ROOT_ROUTES = setOf(
    Screen.Dashboard.route,
    Screen.MyAppointments.route,
    Screen.CatalogTab.route,
    Screen.FinanceTab.route,
    Screen.Profile.route,
)

@Composable
fun WellnessNavGraph(
    modifier: Modifier = Modifier,
    navController: NavHostController = rememberNavController(),
    startDestination: String = Screen.Splash.route,
    notificationIntent: Intent? = null,
    isDarkTheme: Boolean = false,
    onToggleDarkTheme: () -> Unit = {},
    clinicName: String = "",
    unreadNotificationCount: Int = 0,
) {
    LaunchedEffect(notificationIntent) {
        notificationIntent?.let { navController.handleDeepLink(it) }
    }

    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = navBackStackEntry?.destination?.route
    val showChrome = currentRoute != null && currentRoute !in AUTH_ROUTES
    val canNavigateBack = currentRoute !in TAB_ROOT_ROUTES && navController.previousBackStackEntry != null
    val onDashboard = currentRoute == Screen.Dashboard.route
    var isSearchOpen by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }

    Scaffold(
        modifier = modifier,
        topBar = {
            if (showChrome) {
                Column {
                    WellnessTopAppBar(
                        clinicName = clinicName,
                        unreadCount = unreadNotificationCount,
                        isDarkTheme = isDarkTheme,
                        onToggleDarkTheme = onToggleDarkTheme,
                        onNotificationsClick = {
                            navController.navigate(Screen.Notifications.route) {
                                launchSingleTop = true
                            }
                        },
                        onBack = if (canNavigateBack) { { navController.popBackStack() } } else null,
                        onSearchClick = if (onDashboard) {
                            { isSearchOpen = !isSearchOpen; if (!isSearchOpen) searchQuery = "" }
                        } else null,
                        isSearchActive = isSearchOpen,
                    )
                    AnimatedVisibility(visible = onDashboard && isSearchOpen) {
                        OutlinedTextField(
                            value = searchQuery,
                            onValueChange = { searchQuery = it },
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 6.dp),
                            placeholder = { androidx.compose.material3.Text("Search…") },
                            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                            singleLine = true,
                            shape = RoundedCornerShape(12.dp),
                        )
                    }
                }
            }
        },
        bottomBar = {
            if (showChrome) {
                WellnessBottomNavBar(
                    navController = navController,
                    currentRoute = currentRoute,
                )
            }
        },
    ) { innerPadding ->
        NavHost(
            navController = navController,
            startDestination = startDestination,
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            // ── Auth ──────────────────────────────────────────────────────────────
            composable(Screen.Splash.route) {
                val vm: SplashViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            SplashNavEvent.NavigateToDashboard -> navController.navigate(Screen.Dashboard.route) {
                                popUpTo(Screen.Splash.route) { inclusive = true }
                            }
                            SplashNavEvent.NavigateToLogin -> navController.navigate(Screen.Login.route) {
                                popUpTo(Screen.Splash.route) { inclusive = true }
                            }
                        }
                    }
                }
                SplashScreen(state = state)
            }

            composable(Screen.Login.route) {
                val vm: LoginViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            LoginNavEvent.NavigateToDashboard -> navController.navigate(Screen.Dashboard.route) {
                                popUpTo(Screen.Login.route) { inclusive = true }
                            }
                            LoginNavEvent.NavigateToRegister -> navController.navigate(Screen.Register.route)
                        }
                    }
                }
                LoginScreen(state = state, onEvent = vm::onEvent)
            }

            composable(Screen.Register.route) {
                val vm: RegisterViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            RegisterNavEvent.NavigateToDashboard -> navController.navigate(Screen.Dashboard.route) {
                                popUpTo(Screen.Login.route) { inclusive = true }
                            }
                            RegisterNavEvent.NavigateToLogin -> navController.popBackStack()
                        }
                    }
                }
                RegisterScreen(state = state, onEvent = vm::onEvent)
            }

            // ── Home tab ──────────────────────────────────────────────────────────
            composable(
                route = Screen.Dashboard.route,
                deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://screen/dashboard" }),
            ) {
                val vm: DashboardViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navigationEvent.collect { event ->
                        when (event) {
                            DashboardNavEvent.ToAppointments -> navController.navigate(Screen.MyAppointments.route)
                            DashboardNavEvent.ToBooking -> navController.navigate(Screen.BookAppointment.createRoute())
                            DashboardNavEvent.ToPrescriptions -> navController.navigate(Screen.Prescriptions.route)
                            DashboardNavEvent.ToProfile -> navController.navigate(Screen.Profile.route)
                            DashboardNavEvent.ToWallet -> navController.navigate(Screen.Wallet.route)
                            DashboardNavEvent.ToMemberships -> navController.navigate(Screen.Memberships.route)
                            DashboardNavEvent.ToLoyalty -> navController.navigate(Screen.Loyalty.route)
                            DashboardNavEvent.ToNotifications -> navController.navigate(Screen.Notifications.route)
                            DashboardNavEvent.ToGiftCards -> navController.navigate(Screen.GiftCards.route)
                            DashboardNavEvent.ToVisitHistory -> navController.navigate(Screen.VisitHistory.route)
                            DashboardNavEvent.ToTreatmentPlans -> navController.navigate(Screen.TreatmentPlans.route)
                            DashboardNavEvent.ToConsentForms -> navController.navigate(Screen.ConsentForms.route)
                            DashboardNavEvent.ToWaitlist -> navController.navigate(Screen.Waitlist.route)
                            DashboardNavEvent.ToLogin -> navController.navigate(Screen.Login.route) {
                                popUpTo(0) { inclusive = true }
                            }
                        }
                    }
                }
                DashboardScreen(state = state, onEvent = vm::onEvent)
            }

            // ── Appointments tab ──────────────────────────────────────────────────
            composable(
                route = Screen.BookAppointment.route,
                arguments = listOf(
                    navArgument("serviceId") { type = NavType.StringType; nullable = true; defaultValue = null },
                    navArgument("membershipId") { type = NavType.StringType; nullable = true; defaultValue = null },
                ),
                deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://screen/book" }),
            ) {
                val vm: BookAppointmentViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            BookAppointmentNavEvent.Back -> navController.popBackStack()
                            BookAppointmentNavEvent.BookingSuccess -> navController.navigate(Screen.MyAppointments.route) {
                                popUpTo(Screen.BookAppointment.route) { inclusive = true }
                            }
                        }
                    }
                }
                BookAppointmentScreen(state = state, onEvent = vm::onEvent)
            }

            composable(
                route = Screen.MyAppointments.route,
                deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://screen/appointments" }),
            ) {
                val vm: MyAppointmentsViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            MyAppointmentsNavEvent.ToBook -> navController.navigate(Screen.BookAppointment.createRoute())
                            MyAppointmentsNavEvent.ToHistory -> navController.navigate(Screen.VisitHistory.route)
                            MyAppointmentsNavEvent.Back -> navController.popBackStack()
                        }
                    }
                }
                MyAppointmentsScreen(state = state, onEvent = vm::onEvent)
            }

            composable(Screen.VisitHistory.route) {
                val vm: VisitHistoryViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            VisitHistoryNavEvent.Back -> navController.popBackStack()
                        }
                    }
                }
                VisitHistoryScreen(state = state, onEvent = vm::onEvent)
            }

            composable(
                route = Screen.Prescriptions.route,
                deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://screen/prescriptions" }),
            ) {
                val vm: PrescriptionsViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            is PrescriptionsNavEvent.ToPdf -> navController.navigate(
                                Screen.PrescriptionPdf.createRoute(event.prescriptionId)
                            )
                            PrescriptionsNavEvent.Back -> navController.popBackStack()
                        }
                    }
                }
                PrescriptionsScreen(state = state, onEvent = vm::onEvent)
            }

            composable(
                route = Screen.Waitlist.route,
                deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://screen/waitlist" }),
            ) {
                val vm: WaitlistViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            WaitlistNavEvent.Back -> navController.popBackStack()
                        }
                    }
                }
                WaitlistScreen(state = state, onEvent = vm::onEvent)
            }

            composable(route = Screen.PrescriptionPdf.route) {
                val vm: PrescriptionPdfViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            PrescriptionPdfNavEvent.Back -> navController.popBackStack()
                        }
                    }
                }
                PrescriptionPdfScreen(state = state, onEvent = vm::onEvent)
            }

            // ── Catalog tab ───────────────────────────────────────────────────────
            composable(route = Screen.CatalogTab.route) {
                val vm: CatalogViewModel = hiltViewModel()
                val membershipsVm: MembershipsViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                val membershipsState by membershipsVm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            is CatalogNavEvent.ToBooking -> navController.navigate(
                                Screen.BookAppointment.createRoute(serviceId = event.serviceId)
                            )
                        }
                    }
                }
                CatalogTabScreen(
                    state = state,
                    onEvent = vm::onEvent,
                    membershipsContent = {
                        InlineMembershipsTab(
                            state = membershipsState,
                            onEvent = membershipsVm::onEvent,
                        )
                    },
                )
            }

            composable(
                route = Screen.Memberships.route,
                deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://screen/memberships" }),
            ) {
                val vm: MembershipsViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            MembershipsNavEvent.Back -> navController.popBackStack()
                        }
                    }
                }
                MembershipsScreen(state = state, onEvent = vm::onEvent)
            }

            // ── Finance tab ───────────────────────────────────────────────────────
            composable(route = Screen.FinanceTab.route) {
                val financeVm: FinanceViewModel = hiltViewModel()
                val giftVm: GiftCardsViewModel = hiltViewModel()
                val walletVm: WalletViewModel = hiltViewModel()
                val paymentsState by financeVm.uiState.collectAsStateWithLifecycle()
                val giftState by giftVm.uiState.collectAsStateWithLifecycle()
                val walletState by walletVm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    giftVm.navEvent.collect { event ->
                        when (event) {
                            is GiftCardsNavEvent.LaunchRazorpay -> { /* Razorpay SDK launched from Activity */ }
                            GiftCardsNavEvent.Back -> { /* inline — no back nav needed */ }
                            GiftCardsNavEvent.PurchaseComplete -> { /* purchase done inline */ }
                        }
                    }
                }
                FinanceTabScreen(
                    paymentsState = paymentsState,
                    giftState = giftState,
                    walletState = walletState,
                    onPaymentsEvent = financeVm::onEvent,
                    onGiftEvent = giftVm::onEvent,
                    onWalletEvent = walletVm::onEvent,
                )
            }

            composable(
                route = Screen.Wallet.route,
                deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://screen/wallet" }),
            ) {
                val vm: WalletViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            WalletNavEvent.ToGiftCards -> navController.navigate(Screen.GiftCards.route)
                            WalletNavEvent.Back -> navController.popBackStack()
                        }
                    }
                }
                WalletScreen(state = state, onEvent = vm::onEvent)
            }

            composable(Screen.GiftCards.route) {
                val vm: GiftCardsViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            is GiftCardsNavEvent.LaunchRazorpay -> { /* Razorpay SDK launched from Activity context */ }
                            GiftCardsNavEvent.Back -> navController.popBackStack()
                            GiftCardsNavEvent.PurchaseComplete -> navController.navigate(Screen.Wallet.route) {
                                popUpTo(Screen.GiftCards.route) { inclusive = true }
                            }
                        }
                    }
                }
                GiftCardsScreen(state = state, onEvent = vm::onEvent)
            }

            // ── Profile tab ───────────────────────────────────────────────────────
            composable(Screen.Profile.route) {
                val vm: ProfileViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            ProfileNavEvent.Back -> navController.popBackStack()
                            ProfileNavEvent.ToLogin -> navController.navigate(Screen.Login.route) {
                                popUpTo(0) { inclusive = true }
                            }
                            ProfileNavEvent.ToNotificationSettings -> navController.navigate(Screen.NotificationSettings.route)
                        }
                    }
                }
                ProfileScreen(state = state, onEvent = vm::onEvent)
            }

            composable(
                route = Screen.Notifications.route,
                deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://screen/notifications" }),
            ) {
                val vm: NotificationsViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            is NotificationsNavEvent.OpenDeepLink -> {
                                val route = when (event.screen) {
                                    "appointments" -> Screen.MyAppointments.route
                                    "prescriptions" -> Screen.Prescriptions.route
                                    "memberships" -> Screen.Memberships.route
                                    "wallet" -> Screen.Wallet.route
                                    "book" -> Screen.BookAppointment.createRoute()
                                    else -> null
                                }
                                route?.let { navController.navigate(it) }
                            }
                            NotificationsNavEvent.Back -> navController.popBackStack()
                        }
                    }
                }
                NotificationInboxScreen(state = state, onEvent = vm::onEvent)
            }

            composable(route = Screen.NotificationSettings.route) {
                NotificationSettingsScreen(onBack = { navController.popBackStack() })
            }

            composable(
                route = Screen.TreatmentPlans.route,
                deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://screen/treatment_plans" }),
            ) {
                val vm: TreatmentPlansViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            TreatmentPlansNavEvent.Back -> navController.popBackStack()
                        }
                    }
                }
                TreatmentPlansScreen(state = state, onEvent = vm::onEvent)
            }

            composable(
                route = Screen.ConsentForms.route,
                deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://screen/consent_forms" }),
            ) {
                val vm: ConsentFormsViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            is ConsentFormsNavEvent.ToPdf -> navController.navigate(
                                Screen.ConsentFormPdf.createRoute(event.consentId)
                            )
                            ConsentFormsNavEvent.Back -> navController.popBackStack()
                        }
                    }
                }
                ConsentFormsScreen(state = state, onEvent = vm::onEvent)
            }

            composable(Screen.ConsentFormPdf.route) {
                val vm: ConsentFormPdfViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            ConsentFormPdfNavEvent.Back -> navController.popBackStack()
                        }
                    }
                }
                ConsentFormPdfScreen(state = state, onEvent = vm::onEvent)
            }

            composable(
                route = Screen.Loyalty.route,
                deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://screen/loyalty" }),
            ) {
                val vm: LoyaltyViewModel = hiltViewModel()
                val state by vm.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.navEvent.collect { event ->
                        when (event) {
                            LoyaltyNavEvent.Back -> navController.popBackStack()
                        }
                    }
                }
                LoyaltyScreen(state = state, onEvent = vm::onEvent)
            }
        }
    }
}

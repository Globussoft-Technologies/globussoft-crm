package com.globussoft.wellness.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.navigation
import androidx.navigation.compose.rememberNavController
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.feature.admin.navigation.adminGraph
import com.globussoft.wellness.feature.calendar.navigation.calendarGraph
import com.globussoft.wellness.feature.dashboard.navigation.dashboardGraph
import com.globussoft.wellness.feature.finance.navigation.financeGraph
import com.globussoft.wellness.feature.patients.navigation.patientsGraph
import com.globussoft.wellness.feature.reports.navigation.reportsGraph
import com.globussoft.wellness.feature.services.navigation.servicesGraph
import com.globussoft.wellness.feature.settings.navigation.settingsGraph
import com.globussoft.wellness.feature.telecaller.navigation.telecallerGraph
import com.globussoft.wellness.feature.visits.navigation.visitsGraph

fun NavGraphBuilder.mainGraph(
    navController: NavHostController,
    userSession: UserSession?,
    onLogout: () -> Unit,
) {
    navigation(
        route            = MAIN_GRAPH_ROUTE,
        startDestination = "main_shell",
    ) {
        composable("main_shell") {
            val innerNavController = rememberNavController()
            val navBackStackEntry  by innerNavController.currentBackStackEntryAsState()
            val currentRoute       = navBackStackEntry?.destination?.route

            // Tablet two-pane layout: persistent sidebar left, content right.
            Row(Modifier.fillMaxSize()) {
                WellnessPersistentSidebar(
                    currentRoute = currentRoute,
                    userSession  = userSession,
                    onNavigate   = { route ->
                        innerNavController.navigate(route) {
                            popUpTo(innerNavController.graph.startDestinationId) {
                                saveState = true
                            }
                            launchSingleTop = true
                            restoreState    = true
                        }
                    },
                )
                InnerNavHost(
                    navController = innerNavController,
                    userSession   = userSession,
                    onLogout      = onLogout,
                    modifier      = Modifier
                        .weight(1f)
                        .windowInsetsPadding(
                            WindowInsets.safeDrawing.only(
                                androidx.compose.foundation.layout.WindowInsetsSides.Top +
                                androidx.compose.foundation.layout.WindowInsetsSides.End +
                                androidx.compose.foundation.layout.WindowInsetsSides.Bottom
                            )
                        ),
                )
            }
        }
    }
}

@Composable
private fun InnerNavHost(
    navController: NavHostController,
    userSession: UserSession?,
    onLogout: () -> Unit,
    modifier: Modifier = Modifier,
) {
    NavHost(
        navController    = navController,
        startDestination = "dashboard",
        modifier         = modifier,
    ) {
        // ── Full feature screens ──────────────────────────────────────────
        dashboardGraph(navController)
        patientsGraph(navController)
        calendarGraph(navController)   // registers "calendar" + "waitlist"
        servicesGraph(navController)
        financeGraph(navController, userSession)
        visitsGraph(navController)     // registers "visits" + "attendance" + "leave"
        reportsGraph()
        telecallerGraph()
        adminGraph(navController, userSession) // registers "admin" + "locations" + "drugs" + "resources"
        settingsGraph(navController, userSession, onLogout)

        // ── Clinical stubs ────────────────────────────────────────────────
        composable("memberships")   { PlaceholderScreen("Memberships") }
        composable("working-hours") { PlaceholderScreen("Working Hours") }

        // ── Leads & Revenue stubs ─────────────────────────────────────────
        composable("inbox")             { PlaceholderScreen("Unified Inbox") }
        composable("whatsapp")          { PlaceholderScreen("WhatsApp Threads") }
        composable("leads")             { PlaceholderScreen("All Leads") }
        composable("converted-leads")   { PlaceholderScreen("Converted Leads") }
        composable("tasks")             { PlaceholderScreen("Tasks") }
        composable("marketplace-leads") { PlaceholderScreen("Marketplace Leads") }
        composable("lead-routing")      { PlaceholderScreen("Routing Rules") }

        // ── Finance stubs ─────────────────────────────────────────────────
        composable("invoices")       { PlaceholderScreen("Invoices") }
        composable("estimates")      { PlaceholderScreen("Estimates") }
        composable("expenses")       { PlaceholderScreen("Expenses") }
        composable("payments") { PlaceholderScreen("Payments") }

        // ── Marketing stubs ───────────────────────────────────────────────
        composable("marketing")     { PlaceholderScreen("SMS / Email Blasts") }
        composable("sequences")     { PlaceholderScreen("Drip Sequences") }
        composable("landing-pages") { PlaceholderScreen("Landing Pages") }

        // ── Reports stubs ─────────────────────────────────────────────────
        composable("per-location")   { PlaceholderScreen("Per-Location Reports") }
        composable("loyalty")        { PlaceholderScreen("Loyalty + Referrals") }
        composable("surveys")        { PlaceholderScreen("Patient Surveys") }
        composable("knowledge-base") { PlaceholderScreen("Knowledge Base") }

        // ── Inventory stubs ───────────────────────────────────────────────
        composable("inventory-receipts")    { PlaceholderScreen("Inventory Receipts") }
        composable("inventory-adjustments") { PlaceholderScreen("Inventory Adjustments") }

        // ── Admin stubs ───────────────────────────────────────────────────
        composable("staff")                { PlaceholderScreen("Staff Management") }
        composable("commission-profiles")  { PlaceholderScreen("Commission Profiles") }
        composable("revenue-goals")        { PlaceholderScreen("Revenue Goals") }
        composable("channels")             { PlaceholderScreen("Channels") }
        composable("audit-log")            { PlaceholderScreen("Audit Log") }
        composable("privacy")              { PlaceholderScreen("Privacy") }
    }
}

@Composable
private fun PlaceholderScreen(title: String) {
    Box(
        modifier         = Modifier
            .fillMaxSize()
            .padding(32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text      = "$title\n\nThis screen is coming soon.",
            style     = MaterialTheme.typography.bodyLarge,
            color     = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

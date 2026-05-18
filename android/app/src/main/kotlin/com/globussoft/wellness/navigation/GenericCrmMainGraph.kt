package com.globussoft.wellness.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.navigation
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navDeepLink
import com.globussoft.wellness.core.designsystem.components.AdaptiveTwoPaneLayout
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.feature.crm.presentation.contacts.ContactDetailScreen
import com.globussoft.wellness.feature.crm.presentation.contacts.ContactsScreen
import com.globussoft.wellness.feature.crm.presentation.dashboard.CrmDashboardScreen
import com.globussoft.wellness.feature.crm.presentation.deals.DealDetailScreen
import com.globussoft.wellness.feature.crm.presentation.deals.DealsScreen
import com.globussoft.wellness.feature.crm.presentation.approvals.ApprovalsScreen
import com.globussoft.wellness.feature.crm.presentation.auditlog.AuditLogScreen
import com.globussoft.wellness.feature.crm.presentation.channels.ChannelsScreen
import com.globussoft.wellness.feature.crm.presentation.dealinsights.DealInsightsScreen
import com.globussoft.wellness.feature.crm.presentation.estimates.EstimatesScreen
import com.globussoft.wellness.feature.crm.presentation.expenses.ExpensesScreen
import com.globussoft.wellness.feature.crm.presentation.forecasting.ForecastingScreen
import com.globussoft.wellness.feature.crm.presentation.invoices.InvoicesScreen
import com.globussoft.wellness.feature.crm.presentation.knowledgebase.KnowledgeBaseScreen
import com.globussoft.wellness.feature.crm.presentation.leads.LeadsScreen
import com.globussoft.wellness.feature.crm.presentation.marketing.MarketingScreen
import com.globussoft.wellness.feature.crm.presentation.payments.PaymentsScreen
import com.globussoft.wellness.feature.crm.presentation.pipeline.PipelineScreen
import com.globussoft.wellness.feature.crm.presentation.reports.ReportsScreen
import com.globussoft.wellness.feature.crm.presentation.sequences.SequencesScreen
import com.globussoft.wellness.feature.crm.presentation.settings.CrmSettingsScreen
import com.globussoft.wellness.feature.crm.presentation.staff.StaffScreen
import com.globussoft.wellness.feature.crm.presentation.tasks.TasksScreen
import com.globussoft.wellness.feature.crm.presentation.leadrouting.LeadRoutingScreen
import com.globussoft.wellness.feature.crm.presentation.quotas.QuotasScreen
import com.globussoft.wellness.feature.crm.presentation.territories.TerritoriesScreen
import com.globussoft.wellness.feature.crm.presentation.clients.ClientsScreen
import com.globussoft.wellness.feature.crm.presentation.contracts.ContractsScreen
import com.globussoft.wellness.feature.crm.presentation.inbox.InboxScreen
import com.globussoft.wellness.feature.crm.presentation.projects.ProjectsScreen
import com.globussoft.wellness.feature.crm.presentation.sharedinbox.SharedInboxScreen
import com.globussoft.wellness.feature.crm.presentation.surveys.SurveysScreen
import com.globussoft.wellness.feature.crm.presentation.tickets.TicketDetailScreen
import com.globussoft.wellness.feature.crm.presentation.tickets.TicketsScreen

// ─── CRM route constants ──────────────────────────────────────────────────────

object CrmRoutes {
    // Core
    const val DASHBOARD      = "crm-dashboard"
    const val PIPELINE       = "crm-pipeline"
    const val CONTACTS       = "crm-contacts"
    const val CONTACT_DETAIL = "crm-contacts/{contactId}"
    const val LEADS          = "crm-leads"
    const val TASKS          = "crm-tasks"
    const val TICKETS        = "crm-tickets"
    const val TICKET_DETAIL  = "crm-tickets/{ticketId}"
    const val INBOX          = "crm-inbox"

    // Deals
    const val DEALS          = "crm-deals"
    const val DEAL_DETAIL    = "crm-deals/{dealId}"

    // Clients / Contracts / Projects
    const val CLIENTS        = "crm-clients"
    const val CONTRACTS      = "crm-contracts"
    const val PROJECTS       = "crm-projects"

    // Financial
    const val INVOICES       = "crm-invoices"
    const val ESTIMATES      = "crm-estimates"
    const val EXPENSES       = "crm-expenses"
    const val PAYMENTS       = "crm-payments"

    // Sales analytics
    const val PIPELINES      = "crm-pipelines"
    const val FORECASTING    = "crm-forecasting"
    const val QUOTAS         = "crm-quotas"
    const val WIN_LOSS       = "crm-win-loss"
    const val FUNNEL         = "crm-funnel"

    // Analytics
    const val REPORTS        = "crm-reports"
    const val AGENT_REPORTS  = "crm-agent-reports"
    const val DASHBOARDS     = "crm-dashboards"
    const val DEAL_INSIGHTS  = "crm-deal-insights"
    const val APPROVALS      = "crm-approvals"

    // Marketing
    const val MARKETING      = "crm-marketing"
    const val SEQUENCES      = "crm-sequences"
    const val LANDING_PAGES  = "crm-landing-pages"
    const val MARKETPLACE    = "crm-marketplace"

    // Operations
    const val LEAD_ROUTING   = "crm-lead-routing"
    const val TERRITORIES    = "crm-territories"
    const val KNOWLEDGE_BASE = "crm-knowledge-base"
    const val SURVEYS        = "crm-surveys"
    const val SHARED_INBOX   = "crm-shared-inbox"
    const val SUPPORT        = "crm-support"

    // Admin
    const val STAFF          = "crm-staff"
    const val SETTINGS       = "crm-settings"
    const val CHANNELS       = "crm-channels"
    const val AUDIT_LOG      = "crm-audit-log"
    const val PRIVACY        = "crm-privacy"
    const val DEVELOPER      = "crm-developer"
}

// ─── Generic CRM main graph ───────────────────────────────────────────────────

fun NavGraphBuilder.genericCrmMainGraph(
    navController: NavHostController,
    userSession: UserSession?,
    onLogout: () -> Unit,
) {
    navigation(
        route            = MAIN_GRAPH_ROUTE,
        startDestination = "crm_shell",
    ) {
        composable("crm_shell") {
            val innerNavController = rememberNavController()
            val navBackStackEntry  by innerNavController.currentBackStackEntryAsState()
            val currentRoute       = navBackStackEntry?.destination?.route

            Row(Modifier.fillMaxSize()) {
                GenericCrmPersistentSidebar(
                    currentRoute = currentRoute,
                    userSession  = userSession,
                    onLogout     = onLogout,
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
                CrmInnerNavHost(
                    navController = innerNavController,
                    userSession   = userSession,
                    onLogout      = onLogout,
                    modifier      = Modifier
                        .weight(1f)
                        .windowInsetsPadding(
                            WindowInsets.safeDrawing.only(
                                WindowInsetsSides.Top +
                                WindowInsetsSides.End +
                                WindowInsetsSides.Bottom
                            )
                        ),
                )
            }
        }
    }
}

@Composable
private fun CrmInnerNavHost(
    navController: NavHostController,
    userSession: UserSession?,
    onLogout: () -> Unit,
    modifier: Modifier = Modifier,
) {
    NavHost(
        navController    = navController,
        startDestination = CrmRoutes.DASHBOARD,
        modifier         = modifier,
    ) {
        // ── Core ─────────────────────────────────────────────────────────────
        composable(
            route     = CrmRoutes.DASHBOARD,
            deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://crm/dashboard" }),
        ) {
            CrmDashboardScreen()
        }
        composable(
            route     = CrmRoutes.PIPELINE,
            deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://crm/pipeline" }),
        ) {
            PipelineScreen(
                onDealClick = { dealId ->
                    navController.navigate("crm-deals/$dealId")
                }
            )
        }
        composable(
            route      = CrmRoutes.CONTACTS,
            deepLinks  = listOf(navDeepLink { uriPattern = "globuscrm://crm/contacts" }),
        ) {
            var selectedContactId by rememberSaveable { mutableStateOf<String?>(null) }
            AdaptiveTwoPaneLayout(
                showDetailPane = selectedContactId != null,
                listPane = {
                    ContactsScreen(onContactClick = { selectedContactId = it })
                },
                detailPane = {
                    ContactDetailScreen(
                        contactId = selectedContactId ?: "",
                        onBack    = { selectedContactId = null },
                    )
                },
            )
        }
        composable(CrmRoutes.CONTACT_DETAIL) { backStackEntry ->
            val contactId = backStackEntry.arguments?.getString("contactId") ?: ""
            ContactDetailScreen(
                contactId = contactId,
                onBack    = { navController.popBackStack() },
            )
        }
        composable(CrmRoutes.LEADS) {
            LeadsScreen(
                onLeadClick = { contactId ->
                    navController.navigate("crm-contacts/$contactId")
                }
            )
        }
        composable(CrmRoutes.TASKS) {
            TasksScreen()
        }
        composable(
            route     = CrmRoutes.TICKETS,
            deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://crm/tickets" }),
        ) {
            var selectedTicketId by rememberSaveable { mutableStateOf<String?>(null) }
            AdaptiveTwoPaneLayout(
                showDetailPane = selectedTicketId != null,
                listPane = {
                    TicketsScreen(onTicketClick = { selectedTicketId = it })
                },
                detailPane = {
                    TicketDetailScreen(
                        ticketId = selectedTicketId ?: "",
                        onBack   = { selectedTicketId = null },
                    )
                },
            )
        }
        composable(CrmRoutes.TICKET_DETAIL) { backStackEntry ->
            val ticketId = backStackEntry.arguments?.getString("ticketId") ?: ""
            TicketDetailScreen(
                ticketId = ticketId,
                onBack   = { navController.popBackStack() },
            )
        }
        composable(CrmRoutes.CLIENTS) {
            ClientsScreen()
        }
        composable(CrmRoutes.CONTRACTS) {
            ContractsScreen()
        }
        composable(CrmRoutes.PROJECTS) {
            ProjectsScreen()
        }
        composable(CrmRoutes.INBOX) {
            InboxScreen()
        }
        composable(
            route     = CrmRoutes.DEALS,
            deepLinks = listOf(navDeepLink { uriPattern = "globuscrm://crm/deals" }),
        ) {
            var selectedDealId by rememberSaveable { mutableStateOf<String?>(null) }
            AdaptiveTwoPaneLayout(
                showDetailPane = selectedDealId != null,
                listPane = {
                    DealsScreen(onDealClick = { selectedDealId = it })
                },
                detailPane = {
                    DealDetailScreen(
                        dealId = selectedDealId ?: "",
                        onBack = { selectedDealId = null },
                    )
                },
            )
        }
        composable(CrmRoutes.DEAL_DETAIL) { backStackEntry ->
            val dealId = backStackEntry.arguments?.getString("dealId") ?: ""
            DealDetailScreen(
                dealId = dealId,
                onBack = { navController.popBackStack() },
            )
        }

        // ── Financial ────────────────────────────────────────────────────────
        composable(CrmRoutes.INVOICES) {
            InvoicesScreen()
        }
        composable(CrmRoutes.ESTIMATES) {
            EstimatesScreen()
        }
        composable(CrmRoutes.EXPENSES) {
            ExpensesScreen()
        }
        composable(CrmRoutes.PAYMENTS) {
            PaymentsScreen()
        }

        // ── Sales ────────────────────────────────────────────────────────────
        composable(CrmRoutes.PIPELINES) {
            PipelineScreen(onDealClick = { dealId -> navController.navigate("crm-deals/$dealId") })
        }
        composable(CrmRoutes.FORECASTING) {
            ForecastingScreen()
        }
        composable(CrmRoutes.QUOTAS) {
            QuotasScreen()
        }
        composable(CrmRoutes.WIN_LOSS) {
            ReportsScreen()
        }
        composable(CrmRoutes.FUNNEL) {
            ReportsScreen()
        }

        // ── Analytics ────────────────────────────────────────────────────────
        composable(CrmRoutes.REPORTS) {
            ReportsScreen()
        }
        composable(CrmRoutes.AGENT_REPORTS) {
            ReportsScreen()
        }
        composable(CrmRoutes.DASHBOARDS) {
            CrmPlaceholder("Dashboards")
        }
        composable(CrmRoutes.DEAL_INSIGHTS) {
            DealInsightsScreen()
        }
        composable(CrmRoutes.APPROVALS) {
            ApprovalsScreen()
        }

        // ── Marketing ────────────────────────────────────────────────────────
        composable(CrmRoutes.MARKETING) {
            MarketingScreen()
        }
        composable(CrmRoutes.SEQUENCES) {
            SequencesScreen()
        }
        composable(CrmRoutes.LANDING_PAGES) {
            CrmPlaceholder("Landing Pages")
        }
        composable(CrmRoutes.MARKETPLACE) {
            CrmPlaceholder("Marketplace Leads")
        }

        // ── Operations ───────────────────────────────────────────────────────
        composable(CrmRoutes.LEAD_ROUTING) {
            LeadRoutingScreen()
        }
        composable(CrmRoutes.TERRITORIES) {
            TerritoriesScreen()
        }
        composable(CrmRoutes.KNOWLEDGE_BASE) {
            KnowledgeBaseScreen()
        }
        composable(CrmRoutes.SURVEYS) {
            SurveysScreen()
        }
        composable(CrmRoutes.SHARED_INBOX) {
            SharedInboxScreen()
        }
        composable(CrmRoutes.SUPPORT) {
            CrmPlaceholder("Support")
        }

        // ── Admin ────────────────────────────────────────────────────────────
        composable(CrmRoutes.STAFF) {
            StaffScreen()
        }
        composable(CrmRoutes.SETTINGS) {
            CrmSettingsScreen()
        }
        composable(CrmRoutes.CHANNELS) {
            ChannelsScreen()
        }
        composable(CrmRoutes.AUDIT_LOG) {
            AuditLogScreen()
        }
        composable(CrmRoutes.PRIVACY) {
            CrmPlaceholder("Privacy")
        }
        composable(CrmRoutes.DEVELOPER) {
            CrmPlaceholder("Developer")
        }
    }
}

@Composable
private fun CrmPlaceholder(title: String) {
    Box(
        modifier         = Modifier
            .fillMaxSize()
            .padding(32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text      = "$title\n\nComing soon — Wave 3+",
            style     = MaterialTheme.typography.bodyLarge,
            color     = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

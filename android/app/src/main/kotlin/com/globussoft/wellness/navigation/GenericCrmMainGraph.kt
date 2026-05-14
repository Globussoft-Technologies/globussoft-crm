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
import com.globussoft.wellness.core.data.datastore.UserSession

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
        composable(CrmRoutes.DASHBOARD) {
            CrmPlaceholder("Dashboard")
        }
        composable(CrmRoutes.PIPELINE) {
            CrmPlaceholder("Pipeline")
        }
        composable(CrmRoutes.CONTACTS) {
            CrmPlaceholder("Contacts")
        }
        composable(CrmRoutes.CONTACT_DETAIL) {
            CrmPlaceholder("Contact Detail")
        }
        composable(CrmRoutes.LEADS) {
            CrmPlaceholder("Leads")
        }
        composable(CrmRoutes.TASKS) {
            CrmPlaceholder("Tasks")
        }
        composable(CrmRoutes.TICKETS) {
            CrmPlaceholder("Tickets")
        }
        composable(CrmRoutes.TICKET_DETAIL) {
            CrmPlaceholder("Ticket Detail")
        }
        composable(CrmRoutes.INBOX) {
            CrmPlaceholder("Inbox")
        }
        composable(CrmRoutes.DEALS) {
            CrmPlaceholder("Deals")
        }
        composable(CrmRoutes.DEAL_DETAIL) {
            CrmPlaceholder("Deal Detail")
        }

        // ── Financial ────────────────────────────────────────────────────────
        composable(CrmRoutes.INVOICES) {
            CrmPlaceholder("Invoices")
        }
        composable(CrmRoutes.ESTIMATES) {
            CrmPlaceholder("Estimates")
        }
        composable(CrmRoutes.EXPENSES) {
            CrmPlaceholder("Expenses")
        }
        composable(CrmRoutes.PAYMENTS) {
            CrmPlaceholder("Payments")
        }

        // ── Sales ────────────────────────────────────────────────────────────
        composable(CrmRoutes.PIPELINES) {
            CrmPlaceholder("Pipelines")
        }
        composable(CrmRoutes.FORECASTING) {
            CrmPlaceholder("Forecasting")
        }
        composable(CrmRoutes.QUOTAS) {
            CrmPlaceholder("Quotas")
        }
        composable(CrmRoutes.WIN_LOSS) {
            CrmPlaceholder("Win / Loss")
        }
        composable(CrmRoutes.FUNNEL) {
            CrmPlaceholder("Funnel")
        }

        // ── Analytics ────────────────────────────────────────────────────────
        composable(CrmRoutes.REPORTS) {
            CrmPlaceholder("Reports")
        }
        composable(CrmRoutes.AGENT_REPORTS) {
            CrmPlaceholder("Agent Reports")
        }
        composable(CrmRoutes.DASHBOARDS) {
            CrmPlaceholder("Dashboards")
        }
        composable(CrmRoutes.DEAL_INSIGHTS) {
            CrmPlaceholder("Deal Insights")
        }
        composable(CrmRoutes.APPROVALS) {
            CrmPlaceholder("Approvals")
        }

        // ── Marketing ────────────────────────────────────────────────────────
        composable(CrmRoutes.MARKETING) {
            CrmPlaceholder("Marketing Campaigns")
        }
        composable(CrmRoutes.SEQUENCES) {
            CrmPlaceholder("Sequences")
        }
        composable(CrmRoutes.LANDING_PAGES) {
            CrmPlaceholder("Landing Pages")
        }
        composable(CrmRoutes.MARKETPLACE) {
            CrmPlaceholder("Marketplace Leads")
        }

        // ── Operations ───────────────────────────────────────────────────────
        composable(CrmRoutes.LEAD_ROUTING) {
            CrmPlaceholder("Lead Routing")
        }
        composable(CrmRoutes.TERRITORIES) {
            CrmPlaceholder("Territories")
        }
        composable(CrmRoutes.KNOWLEDGE_BASE) {
            CrmPlaceholder("Knowledge Base")
        }
        composable(CrmRoutes.SURVEYS) {
            CrmPlaceholder("Surveys")
        }
        composable(CrmRoutes.SUPPORT) {
            CrmPlaceholder("Support")
        }

        // ── Admin ────────────────────────────────────────────────────────────
        composable(CrmRoutes.STAFF) {
            CrmPlaceholder("Staff")
        }
        composable(CrmRoutes.SETTINGS) {
            CrmPlaceholder("Settings")
        }
        composable(CrmRoutes.CHANNELS) {
            CrmPlaceholder("Channels")
        }
        composable(CrmRoutes.AUDIT_LOG) {
            CrmPlaceholder("Audit Log")
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

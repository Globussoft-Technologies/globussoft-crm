package com.globussoft.wellness.feature.admin.navigation

import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.feature.admin.presentation.AdminScreen
import com.globussoft.wellness.feature.admin.presentation.auditlog.AuditLogScreen
import com.globussoft.wellness.feature.admin.presentation.autoconsumption.AutoConsumptionScreen
import com.globussoft.wellness.feature.admin.presentation.cashbackrules.CashbackRulesScreen
import com.globussoft.wellness.feature.admin.presentation.commissionprofiles.CommissionProfilesScreen
import com.globussoft.wellness.feature.admin.presentation.convertedleads.ConvertedLeadsScreen
import com.globussoft.wellness.feature.admin.presentation.leads.LeadDetailScreen
import com.globussoft.wellness.feature.admin.presentation.leads.LeadsScreen
import com.globussoft.wellness.feature.admin.presentation.routingrules.RoutingRulesScreen
import com.globussoft.wellness.feature.admin.presentation.tasks.TasksScreen
import com.globussoft.wellness.feature.admin.presentation.drugs.DrugsScreen
import com.globussoft.wellness.feature.admin.presentation.holidays.HolidaysScreen
import com.globussoft.wellness.feature.admin.presentation.inventoryadjustments.InventoryAdjustmentsScreen
import com.globussoft.wellness.feature.admin.presentation.inventoryreceipts.InventoryReceiptsScreen
import com.globussoft.wellness.feature.admin.presentation.locations.LocationsScreen
import com.globussoft.wellness.feature.admin.presentation.marketplaceleads.MarketplaceLeadsScreen
import com.globussoft.wellness.feature.admin.presentation.memberships.MembershipsScreen
import com.globussoft.wellness.feature.admin.presentation.privacy.PrivacyScreen
import com.globussoft.wellness.feature.admin.presentation.productcategories.ProductCategoriesScreen
import com.globussoft.wellness.feature.admin.presentation.resources.ResourcesScreen
import com.globussoft.wellness.feature.admin.presentation.revenuegoals.RevenueGoalsScreen
import com.globussoft.wellness.feature.admin.presentation.servicecategories.ServiceCategoriesScreen
import com.globussoft.wellness.feature.admin.presentation.vendors.VendorsScreen
import com.globussoft.wellness.feature.admin.presentation.channels.ChannelsScreen
import com.globussoft.wellness.feature.admin.presentation.knowledgebase.KnowledgeBaseScreen
import com.globussoft.wellness.feature.admin.presentation.landingpages.LandingPagesScreen
import com.globussoft.wellness.feature.admin.presentation.loyalty.LoyaltyScreen
import com.globussoft.wellness.feature.admin.presentation.marketing.MarketingScreen
import com.globussoft.wellness.feature.admin.presentation.notifications.InboxScreen
import com.globussoft.wellness.feature.admin.presentation.sequences.SequencesScreen
import com.globussoft.wellness.feature.admin.presentation.staff.StaffScreen
import com.globussoft.wellness.feature.admin.presentation.surveys.SurveysScreen
import com.globussoft.wellness.feature.admin.presentation.whatsapp.WhatsAppScreen
import com.globussoft.wellness.feature.admin.presentation.workinghours.WorkingHoursScreen

/**
 * Destination route constants for the admin feature graph.
 */
object AdminDestinations {
    const val Admin                = "admin"
    const val Locations            = "locations"
    const val Drugs                = "drugs"
    const val Resources            = "resources"
    const val ServiceCategories    = "service-categories"
    const val Holidays             = "holidays"
    const val CashbackRules        = "cashback-rules"
    const val Vendors              = "vendors"
    const val ProductCategories    = "product-categories"
    const val AutoConsumptionRules = "auto-consumption-rules"
    const val AuditLog             = "audit-log"
    const val MarketplaceLeads     = "marketplace-leads"
    const val ConvertedLeads       = "converted-leads"
    const val Privacy              = "privacy"
    const val InventoryReceipts    = "inventory-receipts"
    const val InventoryAdjustments = "inventory-adjustments"
    const val RevenueGoals         = "revenue-goals"
    const val CommissionProfiles   = "commission-profiles"
    const val WorkingHours         = "working-hours"
    const val Memberships          = "memberships"
    const val Leads                = "leads"
    const val LeadDetail           = "lead-detail/{leadId}"
    const val Tasks                = "tasks"
    const val RoutingRules         = "lead-routing"
    const val Staff                = "staff"
    const val WhatsApp             = "whatsapp"
    const val Inbox                = "inbox"
    const val Marketing            = "marketing"
    const val Sequences            = "sequences"
    const val LandingPages         = "landing-pages"
    const val Surveys              = "surveys"
    const val Loyalty              = "loyalty"
    const val KnowledgeBase        = "knowledge-base"
    const val Channels             = "channels"
}

/**
 * Registers the admin feature's composable destinations into the calling
 * [NavGraphBuilder].
 *
 * Access to any admin destination should be guarded at the app-level navigation
 * graph so only ADMIN / MANAGER users can reach these screens.
 *
 * @param navController Used by [AdminScreen] and sub-screens to navigate
 *                      between the hub and the CRUD destinations.
 * @param userSession   Currently authenticated user session; may be used by
 *                      future sub-screens to conditionally show admin-only actions.
 */
fun NavGraphBuilder.adminGraph(
    navController: NavController,
    userSession: UserSession?,
) {
    composable(AdminDestinations.Admin) {
        AdminScreen(
            navController  = navController,
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.Locations) {
        LocationsScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.Drugs) {
        DrugsScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.Resources) {
        ResourcesScreen(navController = navController)
    }

    composable(AdminDestinations.ServiceCategories) {
        ServiceCategoriesScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.Holidays) {
        HolidaysScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.CashbackRules) {
        CashbackRulesScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.Vendors) {
        VendorsScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.ProductCategories) {
        ProductCategoriesScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.AutoConsumptionRules) {
        AutoConsumptionScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.AuditLog) {
        AuditLogScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.MarketplaceLeads) {
        MarketplaceLeadsScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.ConvertedLeads) {
        ConvertedLeadsScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.Privacy) {
        PrivacyScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.InventoryReceipts) {
        InventoryReceiptsScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.InventoryAdjustments) {
        InventoryAdjustmentsScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.RevenueGoals) {
        RevenueGoalsScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.CommissionProfiles) {
        CommissionProfilesScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.WorkingHours) {
        WorkingHoursScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.Memberships) {
        MembershipsScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.Leads) {
        LeadsScreen(
            viewModel    = hiltViewModel(),
            onLeadClick  = { id -> navController.navigate("lead-detail/$id") },
        )
    }

    composable(AdminDestinations.LeadDetail) {
        LeadDetailScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.Tasks) {
        TasksScreen(viewModel = hiltViewModel())
    }

    composable(AdminDestinations.RoutingRules) {
        RoutingRulesScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(AdminDestinations.Staff) {
        StaffScreen(viewModel = hiltViewModel())
    }

    composable(AdminDestinations.WhatsApp) {
        WhatsAppScreen(viewModel = hiltViewModel())
    }

    composable(AdminDestinations.Inbox) {
        InboxScreen(viewModel = hiltViewModel())
    }

    composable(AdminDestinations.Marketing) {
        MarketingScreen()
    }

    composable(AdminDestinations.Sequences) {
        SequencesScreen(viewModel = hiltViewModel())
    }

    composable(AdminDestinations.LandingPages) {
        LandingPagesScreen(viewModel = hiltViewModel())
    }

    composable(AdminDestinations.Surveys) {
        SurveysScreen(viewModel = hiltViewModel())
    }

    composable(AdminDestinations.Loyalty) {
        LoyaltyScreen()
    }

    composable(AdminDestinations.KnowledgeBase) {
        KnowledgeBaseScreen()
    }

    composable(AdminDestinations.Channels) {
        ChannelsScreen(viewModel = hiltViewModel())
    }
}

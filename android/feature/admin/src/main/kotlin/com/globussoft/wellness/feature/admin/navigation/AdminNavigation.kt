package com.globussoft.wellness.feature.admin.navigation

import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.feature.admin.presentation.AdminScreen
import com.globussoft.wellness.feature.admin.presentation.autoconsumption.AutoConsumptionScreen
import com.globussoft.wellness.feature.admin.presentation.cashbackrules.CashbackRulesScreen
import com.globussoft.wellness.feature.admin.presentation.drugs.DrugsScreen
import com.globussoft.wellness.feature.admin.presentation.holidays.HolidaysScreen
import com.globussoft.wellness.feature.admin.presentation.locations.LocationsScreen
import com.globussoft.wellness.feature.admin.presentation.productcategories.ProductCategoriesScreen
import com.globussoft.wellness.feature.admin.presentation.resources.ResourcesScreen
import com.globussoft.wellness.feature.admin.presentation.servicecategories.ServiceCategoriesScreen
import com.globussoft.wellness.feature.admin.presentation.vendors.VendorsScreen

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
}

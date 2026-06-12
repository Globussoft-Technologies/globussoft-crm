package com.globus.crm.core.navigation

import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.foundation.basicMarquee
import androidx.navigation.NavController
import androidx.navigation.NavGraph.Companion.findStartDestination

@Composable
fun WellnessBottomNavBar(
    navController: NavController,
    currentRoute: String?,
) {
    val currentTab = Tab.all.firstOrNull { tab ->
        currentRoute?.let { tabContainsRoute(tab, it) } ?: false
    } ?: Tab.Home

    NavigationBar {
        Tab.all.forEach { tab ->
            NavigationBarItem(
                selected = tab == currentTab,
                onClick = {
                    if (tab != currentTab) {
                        navController.navigate(tabLandingRoute(tab)) {
                            popUpTo(navController.graph.findStartDestination().id) {
                                saveState = true
                            }
                            launchSingleTop = true
                            restoreState = true
                        }
                    }
                },
                icon = { Icon(imageVector = tab.icon, contentDescription = tab.label) },
                label = { Text(text = tab.label, maxLines = 1, modifier = Modifier.basicMarquee()) },
            )
        }
    }
}

private fun tabContainsRoute(tab: Tab, route: String): Boolean = when (tab) {
    Tab.Home -> route == Screen.Dashboard.route
    Tab.Appointments -> route.startsWith("book_appointment") ||
            route == Screen.MyAppointments.route ||
            route == Screen.VisitHistory.route ||
            route == Screen.Prescriptions.route ||
            route.startsWith("prescription_pdf") ||
            route == Screen.Waitlist.route
    Tab.Catalog -> route == Screen.CatalogTab.route ||
            route == Screen.Memberships.route
    Tab.Finance -> route == Screen.FinanceTab.route ||
            route == Screen.Wallet.route ||
            route == Screen.GiftCards.route
    Tab.Profile -> route == Screen.Profile.route ||
            route == Screen.Notifications.route ||
            route == Screen.TreatmentPlans.route ||
            route == Screen.ConsentForms.route ||
            route.startsWith("consent_form_pdf") ||
            route == Screen.Loyalty.route
}

fun tabLandingRoute(tab: Tab): String = when (tab) {
    Tab.Home -> Screen.Dashboard.route
    Tab.Appointments -> Screen.MyAppointments.route
    Tab.Catalog -> Screen.CatalogTab.route
    Tab.Finance -> Screen.FinanceTab.route
    Tab.Profile -> Screen.Profile.route
}

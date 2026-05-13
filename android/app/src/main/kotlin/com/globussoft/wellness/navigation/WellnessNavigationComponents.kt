package com.globussoft.wellness.navigation

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CreditCard
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.MedicalServices
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.MedicalServices
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.core.domain.model.UserRole
import com.globussoft.wellness.core.domain.model.WellnessRole

data class NavItem(
    val route: String,
    val label: String,
    val selectedIcon: ImageVector,
    val unselectedIcon: ImageVector,
    val requiresRole: UserRole? = null,
    val requiresWellnessRole: WellnessRole? = null
)

val wellnessNavItems = listOf(
    NavItem("dashboard", "Dashboard", Icons.Filled.Dashboard, Icons.Outlined.Dashboard),
    NavItem("patients", "Patients", Icons.Filled.People, Icons.Outlined.People),
    NavItem("calendar", "Calendar", Icons.Filled.CalendarMonth, Icons.Outlined.CalendarMonth),
    NavItem("services", "Services", Icons.Filled.MedicalServices, Icons.Outlined.MedicalServices),
    NavItem("finance", "Finance", Icons.Filled.CreditCard, Icons.Outlined.CreditCard, requiresRole = UserRole.MANAGER),
    NavItem("reports", "Reports", Icons.Filled.BarChart, Icons.Outlined.BarChart, requiresRole = UserRole.MANAGER),
    NavItem("telecaller", "Telecaller", Icons.Filled.Phone, Icons.Outlined.Phone, requiresWellnessRole = WellnessRole.TELECALLER),
    NavItem("settings", "Settings", Icons.Filled.Settings, Icons.Outlined.Settings),
)

private fun visibleItems(userSession: UserSession?) = wellnessNavItems.filter { item ->
    when {
        item.requiresWellnessRole != null -> userSession?.wellnessRole == item.requiresWellnessRole
        item.requiresRole == UserRole.MANAGER -> userSession?.isManager == true
        else -> true
    }
}

@Composable
fun WellnessNavigationRail(
    currentRoute: String?,
    userSession: UserSession?,
    onNavigate: (String) -> Unit
) {
    NavigationRail {
        Spacer(Modifier.height(16.dp))
        visibleItems(userSession).forEach { item ->
            val selected = currentRoute?.startsWith(item.route) == true
            NavigationRailItem(
                selected = selected,
                onClick = { onNavigate(item.route) },
                icon = {
                    Icon(
                        imageVector = if (selected) item.selectedIcon else item.unselectedIcon,
                        contentDescription = item.label
                    )
                },
                label = { Text(item.label) }
            )
        }
    }
}

@Composable
fun WellnessBottomBar(
    currentRoute: String?,
    userSession: UserSession?,
    onNavigate: (String) -> Unit
) {
    // Show max 5 items in bottom bar for compact portrait mode
    val items = visibleItems(userSession).take(5)
    NavigationBar {
        items.forEach { item ->
            val selected = currentRoute?.startsWith(item.route) == true
            NavigationBarItem(
                selected = selected,
                onClick = { onNavigate(item.route) },
                icon = {
                    Icon(
                        imageVector = if (selected) item.selectedIcon else item.unselectedIcon,
                        contentDescription = item.label
                    )
                },
                label = { Text(item.label) }
            )
        }
    }
}

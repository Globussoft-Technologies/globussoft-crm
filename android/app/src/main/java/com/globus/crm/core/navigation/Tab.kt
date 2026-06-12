package com.globus.crm.core.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.ui.graphics.vector.ImageVector

sealed class Tab(val route: String, val icon: ImageVector, val label: String) {
    object Home         : Tab("tab_home",         Icons.Filled.Home,                 "Home")
    object Appointments : Tab("tab_appointments", Icons.Filled.CalendarToday,        "Bookings")
    object Catalog      : Tab("tab_catalog",      Icons.Filled.Category,             "Catalog")
    object Finance      : Tab("tab_finance",      Icons.Filled.AccountBalanceWallet, "Finance")
    object Profile      : Tab("tab_profile",      Icons.Filled.Person,               "Profile")

    companion object {
        val all = listOf(Home, Appointments, Catalog, Finance, Profile)
    }
}

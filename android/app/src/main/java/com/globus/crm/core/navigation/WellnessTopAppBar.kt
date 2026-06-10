package com.globus.crm.core.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsNone
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontWeight

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WellnessTopAppBar(
    clinicName: String,
    unreadCount: Int,
    isDarkTheme: Boolean,
    onToggleDarkTheme: () -> Unit,
    onNotificationsClick: () -> Unit,
    onBack: (() -> Unit)? = null,
    onSearchClick: (() -> Unit)? = null,
    isSearchActive: Boolean = false,
) {
    TopAppBar(
        title = {
            Text(
                text = clinicName.ifBlank { "Wellness" },
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        },
        navigationIcon = {
            if (onBack != null) {
                IconButton(onClick = onBack) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = "Back",
                    )
                }
            }
        },
        actions = {
            if (onSearchClick != null) {
                IconButton(onClick = onSearchClick) {
                    Icon(
                        imageVector = if (isSearchActive) Icons.Default.Close else Icons.Default.Search,
                        contentDescription = if (isSearchActive) "Close search" else "Search",
                    )
                }
            }
            IconButton(onClick = onToggleDarkTheme) {
                Icon(
                    imageVector = if (isDarkTheme) Icons.Filled.LightMode else Icons.Filled.DarkMode,
                    contentDescription = if (isDarkTheme) "Switch to light mode" else "Switch to dark mode",
                )
            }
            IconButton(onClick = onNotificationsClick) {
                BadgedBox(
                    badge = {
                        if (unreadCount > 0) {
                            Badge {
                                Text(text = if (unreadCount > 99) "99+" else unreadCount.toString())
                            }
                        }
                    },
                ) {
                    Icon(
                        imageVector = if (unreadCount > 0) Icons.Filled.Notifications else Icons.Filled.NotificationsNone,
                        contentDescription = "Notifications",
                    )
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
    )
}

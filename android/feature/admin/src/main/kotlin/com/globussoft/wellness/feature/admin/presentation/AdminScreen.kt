package com.globussoft.wellness.feature.admin.presentation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowForwardIos
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.MedicalServices
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.navigation.NavController
import androidx.navigation.compose.rememberNavController
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.globussoft.wellness.feature.admin.navigation.AdminDestinations

private data class AdminSection(
    val route: String,
    val title: String,
    val subtitle: String,
    val icon: ImageVector,
    val isStub: Boolean = false,
)

private val ADMIN_SECTIONS = listOf(
    AdminSection(
        route    = AdminDestinations.Locations,
        title    = "Locations",
        subtitle = "Manage clinic branches and addresses",
        icon     = Icons.Default.LocationOn,
    ),
    AdminSection(
        route    = AdminDestinations.Drugs,
        title    = "Drug Catalogue",
        subtitle = "Formulary for prescriptions",
        icon     = Icons.Default.MedicalServices,
    ),
    AdminSection(
        route    = AdminDestinations.Resources,
        title    = "Resources",
        subtitle = "Treatment rooms, equipment",
        icon     = Icons.Default.Settings,
    ),
    AdminSection(
        route    = AdminDestinations.Holidays,
        title    = "Holidays",
        subtitle = "Public holidays and clinic closures",
        icon     = Icons.Default.CalendarMonth,
    ),
    AdminSection(
        route    = AdminDestinations.WorkingHours,
        title    = "Working Hours",
        subtitle = "Default opening and closing times",
        icon     = Icons.Default.AccessTime,
    ),
    AdminSection(
        route    = AdminDestinations.Staff,
        title    = "Staff",
        subtitle = "Manage staff members and roles",
        icon     = Icons.Default.Group,
    ),
)

/**
 * Admin hub screen.
 *
 * Lists all admin sub-sections as tappable [ListItem] rows inside [WellnessCard]
 * containers.  Stub sections show a "(coming soon)" label and do not navigate.
 * Live sections navigate to their respective composable destination.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AdminScreen(
    navController: NavController,
    onNavigateBack: () -> Unit = {},
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        "Admin",
                        style      = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        LazyColumn(
            contentPadding      = PaddingValues(Dimens.SpacingLg),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
            modifier            = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            items(ADMIN_SECTIONS) { section ->
                AdminSectionRow(
                    section = section,
                    onClick = {
                        if (!section.isStub) navController.navigate(section.route)
                    },
                )
            }
        }
    }
}

@Composable
private fun AdminSectionRow(
    section: AdminSection,
    onClick: () -> Unit,
) {
    WellnessCard(
        modifier = Modifier.fillMaxWidth(),
        onClick  = if (!section.isStub) onClick else null,
    ) {
        ListItem(
            headlineContent = {
                Text(
                    text       = section.title,
                    style      = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    color      = if (section.isStub) MaterialTheme.colorScheme.onSurfaceVariant
                                 else MaterialTheme.colorScheme.onSurface,
                )
            },
            supportingContent = {
                Text(
                    text  = if (section.isStub) "${section.subtitle} (coming soon)"
                            else section.subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            },
            leadingContent = {
                Icon(
                    imageVector        = section.icon,
                    contentDescription = null,
                    tint               = if (section.isStub) MaterialTheme.colorScheme.onSurfaceVariant
                                         else WellnessPrimary,
                    modifier           = Modifier.size(24.dp),
                )
            },
            trailingContent = {
                if (!section.isStub) {
                    Icon(
                        imageVector        = Icons.Default.ArrowForwardIos,
                        contentDescription = null,
                        tint               = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier           = Modifier.size(16.dp),
                    )
                }
            },
            colors = ListItemDefaults.colors(
                containerColor = androidx.compose.ui.graphics.Color.Transparent,
            ),
        )
    }
}

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "AdminScreen", showBackground = true)
@Composable
private fun AdminScreenPreview() {
    WellnessTheme {
        AdminScreen(navController = rememberNavController())
    }
}

package com.globussoft.wellness.feature.settings.presentation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.core.designsystem.components.ConfirmDialog
import com.globussoft.wellness.core.designsystem.components.WellnessAvatar
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessDangerButton
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.globussoft.wellness.core.domain.model.UserRole
import kotlinx.coroutines.launch

// ─── App version constant (displayed in About row) ───────────────────────────
private const val APP_VERSION = "3.7.1"

/**
 * Settings screen.
 *
 * Shows the authenticated user's profile card, a settings section with Dark Mode
 * toggle and About row, and a danger-zone Sign Out button with a confirm dialog.
 *
 * @param viewModel  Hilt-injected [SettingsViewModel] (default).
 * @param onLogout   Called after a successful sign-out so the host can navigate
 *                   to the login screen.
 * @param userSession Currently active session (may differ from the ViewModel's
 *                   observed value during the initial compose before flow emission).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel = hiltViewModel(),
    onLogout: () -> Unit = {},
    userSession: UserSession? = null,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    // Collect one-shot effects.
    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                SettingsEffect.NavigateToLogin -> onLogout()
            }
        }
    }

    // Use ViewModel's session if available; fall back to the passed-in value.
    val session = state.userSession ?: userSession

    Scaffold(
        snackbarHost   = { SnackbarHost(snackbarHostState) },
        topBar         = {
            TopAppBar(
                title  = {
                    Text(
                        "Settings",
                        style      = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
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
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingLg),
            modifier            = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            // Profile card.
            if (session != null) {
                item { ProfileCard(session = session) }
            }

            // Settings section.
            item {
                SettingsSection(
                    isDarkMode    = state.isDarkMode,
                    onToggleDark  = { viewModel.onEvent(SettingsEvent.ToggleDarkMode) },
                )
            }

            // Danger zone.
            item {
                DangerZone(
                    isLoggingOut = state.isLoggingOut,
                    onSignOut    = { viewModel.onEvent(SettingsEvent.LogoutRequested) },
                )
            }
        }

        // Sign-out confirm dialog.
        if (state.showLogoutConfirm) {
            ConfirmDialog(
                title         = "Sign Out?",
                message       = "You will need to sign in again to access the app.",
                confirmLabel  = "Sign Out",
                isDestructive = true,
                onConfirm     = { viewModel.onEvent(SettingsEvent.ConfirmLogout) },
                onDismiss     = { viewModel.onEvent(SettingsEvent.DismissLogoutConfirm) },
            )
        }
    }
}

// ─── Profile card ─────────────────────────────────────────────────────────────

@Composable
private fun ProfileCard(session: UserSession) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WellnessAvatar(
                name = session.name,
                size = 56.dp,
            )

            Spacer(modifier = Modifier.width(Dimens.SpacingMd))

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text       = session.name,
                    style      = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text  = session.email,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.height(Dimens.SpacingSm))
                Row(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs)) {
                    RoleBadge(label = session.role.name)
                    session.wellnessRole?.let { wellnessRole ->
                        RoleBadge(
                            label     = wellnessRole.name,
                                tintColor = WellnessPrimary.copy(alpha = 0.15f),
                            textColor = WellnessPrimary,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun RoleBadge(
    label: String,
    tintColor: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.secondaryContainer,
    textColor: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onSecondaryContainer,
) {
    androidx.compose.material3.AssistChip(
        onClick = {},
        label   = {
            Text(
                text  = label.lowercase().replaceFirstChar { it.uppercase() },
                style = MaterialTheme.typography.labelSmall,
                color = textColor,
            )
        },
        colors = androidx.compose.material3.AssistChipDefaults.assistChipColors(
            containerColor = tintColor,
            labelColor     = textColor,
        ),
    )
}

// ─── Settings section ─────────────────────────────────────────────────────────

@Composable
private fun SettingsSection(
    isDarkMode: Boolean,
    onToggleDark: () -> Unit,
) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column {
            ListItem(
                headlineContent = {
                    Text(
                        "Dark Mode",
                        style = MaterialTheme.typography.bodyLarge,
                    )
                },
                leadingContent = {
                    Icon(
                        imageVector        = Icons.Default.DarkMode,
                        contentDescription = null,
                        tint               = WellnessPrimary,
                        modifier           = Modifier.size(22.dp),
                    )
                },
                trailingContent = {
                    Switch(
                        checked         = isDarkMode,
                        onCheckedChange = { onToggleDark() },
                        colors          = SwitchDefaults.colors(
                            checkedTrackColor   = WellnessPrimary,
                            uncheckedTrackColor = MaterialTheme.colorScheme.surfaceVariant,
                        ),
                    )
                },
                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            )

            HorizontalDivider(
                modifier = Modifier.padding(horizontal = Dimens.SpacingLg),
                color    = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
            )

            ListItem(
                headlineContent = {
                    Text(
                        "About",
                        style = MaterialTheme.typography.bodyLarge,
                    )
                },
                supportingContent = {
                    Text(
                        "Globussoft Wellness CRM v$APP_VERSION",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
                leadingContent = {
                    Icon(
                        imageVector        = Icons.Default.Info,
                        contentDescription = null,
                        tint               = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier           = Modifier.size(22.dp),
                    )
                },
                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            )
        }
    }
}

// ─── Danger zone ──────────────────────────────────────────────────────────────

@Composable
private fun DangerZone(
    isLoggingOut: Boolean,
    onSignOut: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
    ) {
        Text(
            text  = "Account",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontWeight = FontWeight.SemiBold,
        )
        WellnessDangerButton(
            text     = if (isLoggingOut) "Signing out…" else "Sign Out",
            onClick  = onSignOut,
            enabled  = !isLoggingOut,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "SettingsScreen – logged in", showBackground = true)
@Composable
private fun SettingsScreenPreview() {
    WellnessTheme {
        SettingsScreen(
            userSession = UserSession(
                accessToken  = "tok",
                userId       = "u1",
                email        = "rishu@enhancedwellness.in",
                name         = "Rishu Verma",
                role         = UserRole.ADMIN,
                wellnessRole = com.globussoft.wellness.core.domain.model.WellnessRole.DOCTOR,
                tenantId     = "t1",
                tenantName   = "Enhanced Wellness",
                vertical     = "wellness",
            ),
        )
    }
}

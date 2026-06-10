package com.globus.crm.feature.dashboard.presentation.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.EventNote
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.CardMembership
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Healing
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.MedicalServices
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.globus.crm.core.theme.WellnessGold
import com.globus.crm.core.theme.WellnessGoldContainer
import com.globus.crm.core.ui.ErrorState
import com.globus.crm.core.ui.GradientHeroCard
import com.globus.crm.core.ui.SectionLabel
import com.globus.crm.core.ui.StatusChip
import com.globus.crm.core.ui.WellnessCard
import com.globus.crm.core.util.CurrencyUtil
import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.dashboard.domain.model.UpcomingVisit
import com.globus.crm.feature.dashboard.presentation.state.DashboardUiEvent
import com.globus.crm.feature.dashboard.presentation.state.DashboardUiState
import java.util.Calendar

private data class PortalTile(
    val label: String,
    val subtitle: String,
    val icon: ImageVector,
    val event: DashboardUiEvent,
)

@Composable
fun DashboardScreen(
    state: DashboardUiState,
    onEvent: (DashboardUiEvent) -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        when {
            state.isLoading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            state.error != null -> ErrorState(
                message = state.error,
                onRetry = { onEvent(DashboardUiEvent.Refresh) },
                modifier = Modifier.align(Alignment.Center),
            )
            else -> DashboardContent(state = state, onEvent = onEvent)
        }
    }
}

@Composable
private fun DashboardContent(
    state: DashboardUiState,
    onEvent: (DashboardUiEvent) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        GreetingHeader(patientName = state.dashboard?.patientName.orEmpty())

        SectionLabel(text = "Overview")
        StatRow(
            walletBalance = state.dashboard?.walletBalance,
            walletCurrency = state.dashboard?.walletCurrency,
            membershipCount = state.dashboard?.activeMembershipCount ?: 0,
            loyaltyPoints = state.dashboard?.loyaltyPoints,
            onWalletClick = { onEvent(DashboardUiEvent.NavigateToWallet) },
            onMembershipsClick = { onEvent(DashboardUiEvent.NavigateToMemberships) },
            onLoyaltyClick = { onEvent(DashboardUiEvent.NavigateToLoyalty) },
        )

        if (state.dashboard?.nextVisit != null) {
            NextVisitCard(
                visit = state.dashboard.nextVisit,
                onClick = { onEvent(DashboardUiEvent.NavigateToAppointments) },
            )
        } else {
            NoUpcomingVisitCard(
                onBookClick = { onEvent(DashboardUiEvent.NavigateToBooking) },
            )
        }

        PortalMenu(onEvent = onEvent)

        Spacer(modifier = Modifier.height(8.dp))
    }
}

@Composable
private fun GreetingHeader(patientName: String) {
    val greeting = remember {
        val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        when {
            hour < 12 -> "Good morning"
            hour < 17 -> "Good afternoon"
            else -> "Good evening"
        }
    }
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f).padding(end = 8.dp)) {
            Text(
                text = if (patientName.isNotBlank()) "$greeting, $patientName" else greeting,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                modifier = Modifier.basicMarquee(),
            )
            Text(
                text = "Welcome back",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        AssistChip(
            onClick = {},
            label = {
                Text(
                    text = "CUSTOMER",
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                )
            },
            colors = AssistChipDefaults.assistChipColors(
                containerColor = MaterialTheme.colorScheme.secondaryContainer,
                labelColor = MaterialTheme.colorScheme.onSecondaryContainer,
            ),
        )
    }
}

@Composable
private fun NextVisitCard(visit: UpcomingVisit, onClick: () -> Unit) {
    GradientHeroCard(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Next appointment",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
                StatusChip(status = visit.status)
            }
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = DateUtil.toDisplayDate(visit.visitDate),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            if (!visit.serviceName.isNullOrBlank()) {
                Text(
                    text = visit.serviceName,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
            if (!visit.doctorName.isNullOrBlank()) {
                Text(
                    text = "with ${visit.doctorName}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.75f),
                )
            }
        }
    }
}

@Composable
private fun NoUpcomingVisitCard(onBookClick: () -> Unit) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text(
                    text = "No upcoming appointments",
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(
                    text = "Book a visit today",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = onBookClick) {
                Text("Book now")
            }
        }
    }
}

@Composable
private fun StatRow(
    walletBalance: Long?,
    walletCurrency: String?,
    membershipCount: Int,
    loyaltyPoints: Int?,
    onWalletClick: () -> Unit,
    onMembershipsClick: () -> Unit,
    onLoyaltyClick: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        StatChip(
            modifier = Modifier.weight(1f),
            label = "Wallet",
            value = if (walletBalance != null) {
                CurrencyUtil.formatPaise(walletBalance, walletCurrency ?: "INR")
            } else "—",
            icon = Icons.Default.AccountBalanceWallet,
            onClick = onWalletClick,
        )
        StatChip(
            modifier = Modifier.weight(1f),
            label = "Membership",
            value = if (membershipCount > 0) "Active" else "—",
            icon = Icons.Default.CardMembership,
            onClick = onMembershipsClick,
        )
        StatChip(
            modifier = Modifier.weight(1f),
            label = "Loyalty",
            value = if (loyaltyPoints != null) "$loyaltyPoints pts" else "—",
            icon = Icons.Default.Star,
            onClick = onLoyaltyClick,
        )
    }
}

@Composable
private fun StatChip(
    label: String,
    value: String,
    icon: ImageVector,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    WellnessCard(modifier = modifier, onClick = onClick) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(18.dp),
                )
            }
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                text = value,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = label,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun PortalMenu(onEvent: (DashboardUiEvent) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        PortalSection(
            title = "Appointments",
            containerColor = cs.primaryContainer.copy(alpha = 0.5f),
            iconTint = cs.primary,
            tiles = listOf(
                PortalTile("Book Appointment", "Schedule a visit", Icons.Default.CalendarToday, DashboardUiEvent.NavigateToBooking),
                PortalTile("My Bookings", "Upcoming & past", Icons.AutoMirrored.Filled.EventNote, DashboardUiEvent.NavigateToAppointments),
                PortalTile("Visit History", "All visits", Icons.Default.History, DashboardUiEvent.NavigateToVisitHistory),
                PortalTile("Waitlist", "Join a queue", Icons.Default.AccessTime, DashboardUiEvent.NavigateToWaitlist),
            ),
            onEvent = onEvent,
        )
        PortalSection(
            title = "Clinical",
            containerColor = cs.secondaryContainer.copy(alpha = 0.5f),
            iconTint = cs.secondary,
            tiles = listOf(
                PortalTile("Prescriptions", "Your medicines", Icons.Default.MedicalServices, DashboardUiEvent.NavigateToPrescriptions),
                PortalTile("Treatment Plans", "Active plans", Icons.Default.Healing, DashboardUiEvent.NavigateToTreatmentPlans),
                PortalTile("Consent Forms", "Signed documents", Icons.Default.Description, DashboardUiEvent.NavigateToConsentForms),
            ),
            onEvent = onEvent,
        )
        PortalSection(
            title = "Finance",
            containerColor = cs.tertiaryContainer.copy(alpha = 0.6f),
            iconTint = cs.tertiary,
            tiles = listOf(
                PortalTile("Wallet", "Balance & history", Icons.Default.AccountBalanceWallet, DashboardUiEvent.NavigateToWallet),
                PortalTile("Gift Cards", "Buy & redeem", Icons.Default.CardGiftcard, DashboardUiEvent.NavigateToGiftCards),
            ),
            onEvent = onEvent,
        )
        PortalSection(
            title = "Catalog",
            containerColor = WellnessGoldContainer,
            iconTint = WellnessGold,
            tiles = listOf(
                PortalTile("Memberships", "Active plans", Icons.Default.CardMembership, DashboardUiEvent.NavigateToMemberships),
                PortalTile("Loyalty & Referrals", "Points & rewards", Icons.Default.Star, DashboardUiEvent.NavigateToLoyalty),
            ),
            onEvent = onEvent,
        )
        PortalSection(
            title = "Account",
            containerColor = cs.surfaceContainerHigh,
            iconTint = cs.onSurfaceVariant,
            tiles = listOf(
                PortalTile("Profile", "Your details", Icons.Default.Person, DashboardUiEvent.NavigateToProfile),
                PortalTile("Notifications", "Inbox", Icons.Default.Notifications, DashboardUiEvent.NavigateToNotifications),
            ),
            onEvent = onEvent,
        )
    }
}

@Composable
private fun PortalSection(
    title: String,
    containerColor: Color,
    iconTint: Color,
    tiles: List<PortalTile>,
    onEvent: (DashboardUiEvent) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel(text = title)
        tiles.chunked(2).forEach { row ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                row.forEach { tile ->
                    MenuTile(
                        tile = tile,
                        containerColor = containerColor,
                        iconTint = iconTint,
                        onClick = { onEvent(tile.event) },
                        modifier = Modifier.weight(1f),
                    )
                }
                if (row.size == 1) Spacer(modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun MenuTile(
    tile: PortalTile,
    containerColor: Color,
    iconTint: Color,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    WellnessCard(modifier = modifier, onClick = onClick) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(containerColor),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = tile.icon,
                    contentDescription = null,
                    tint = iconTint,
                    modifier = Modifier.size(22.dp),
                )
            }
            Text(
                text = tile.label,
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                text = tile.subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

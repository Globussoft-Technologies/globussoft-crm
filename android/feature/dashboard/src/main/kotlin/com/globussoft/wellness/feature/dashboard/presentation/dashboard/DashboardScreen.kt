package com.globussoft.wellness.feature.dashboard.presentation.dashboard

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.MedicalServices
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.PendingActions
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.TrendingUp
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.patrykandpatrick.vico.compose.cartesian.CartesianChartHost
import com.patrykandpatrick.vico.compose.cartesian.layer.rememberLineCartesianLayer
import com.patrykandpatrick.vico.compose.cartesian.rememberCartesianChart
import com.patrykandpatrick.vico.core.cartesian.data.CartesianChartModelProducer
import com.patrykandpatrick.vico.core.cartesian.data.lineSeries
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessAccent
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessSuccess
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.globussoft.wellness.core.designsystem.theme.WellnessWarning
import com.globussoft.wellness.core.domain.model.DashboardData
import com.globussoft.wellness.core.domain.model.Location
import com.globussoft.wellness.core.domain.model.RevenueTrendPoint
import kotlinx.coroutines.launch
import java.util.Calendar

// ─── Public composable ────────────────────────────────────────────────────────

/**
 * Owner Dashboard screen.
 *
 * Shows KPI stat cards, yesterday summary, a 30-day revenue trend chart,
 * and quick-action shortcuts.  Wraps content in [PullToRefreshBox] for
 * pull-to-refresh support.
 *
 * @param viewModel  Hilt-injected [DashboardViewModel] (default).
 * @param onNavigate Called when a quick-action card is tapped; receives the
 *                   destination route string.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    viewModel: DashboardViewModel = hiltViewModel(),
    onNavigate: (String) -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is DashboardEffect.NavigateTo -> onNavigate(effect.route)
                is DashboardEffect.ShowError  -> scope.launch {
                    snackbarHostState.showSnackbar(effect.message)
                }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            DashboardTopBar(
                userName    = "",    // resolved from AuthDataStore in real usage
                locations   = state.locations,
                selectedId  = state.selectedLocationId,
                onSelectLocation = { viewModel.onEvent(DashboardEvent.SelectLocation(it)) },
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.data != null,
            onRefresh    = { viewModel.onEvent(DashboardEvent.Refresh) },
            modifier     = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            when {
                state.isLoading && state.data == null -> {
                    ShimmerList(itemCount = 6, modifier = Modifier.fillMaxSize())
                }
                state.error != null && state.data == null -> {
                    ErrorState(
                        message  = state.error,
                        onRetry  = { viewModel.onEvent(DashboardEvent.Refresh) },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                state.data != null -> {
                    DashboardContent(
                        data       = state.data!!,
                        onNavigate = onNavigate,
                    )
                }
            }
        }
    }
}

// ─── TopAppBar ────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DashboardTopBar(
    userName: String,
    locations: List<Location>,
    selectedId: String?,
    onSelectLocation: (String?) -> Unit,
) {
    val greeting = greetingByHour()
    val displayName = userName.ifBlank { "Owner" }

    var locationMenuExpanded by remember { mutableStateOf(false) }
    val selectedName = locations.firstOrNull { it.id == selectedId }?.name ?: "All Locations"

    TopAppBar(
        title = {
            Column {
                Text(
                    text  = "$greeting, $displayName",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                if (locations.size > 1) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier          = Modifier.padding(top = 1.dp),
                    ) {
                        Text(
                            text  = selectedName,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Icon(
                            imageVector        = Icons.Outlined.KeyboardArrowDown,
                            contentDescription = "Change location",
                            tint               = MaterialTheme.colorScheme.primary,
                            modifier           = Modifier.size(14.dp),
                        )
                    }
                }
            }
        },
        actions = {
            if (locations.size > 1) {
                Box {
                    IconButton(onClick = { locationMenuExpanded = true }) {
                        Icon(
                            imageVector        = Icons.Outlined.KeyboardArrowDown,
                            contentDescription = "Filter by location",
                        )
                    }
                    DropdownMenu(
                        expanded         = locationMenuExpanded,
                        onDismissRequest = { locationMenuExpanded = false },
                    ) {
                        DropdownMenuItem(
                            text    = { Text("All Locations") },
                            onClick = {
                                onSelectLocation(null)
                                locationMenuExpanded = false
                            },
                        )
                        locations.forEach { loc ->
                            DropdownMenuItem(
                                text    = { Text(loc.name) },
                                onClick = {
                                    onSelectLocation(loc.id)
                                    locationMenuExpanded = false
                                },
                            )
                        }
                    }
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
    )
}

// ─── Main dashboard content ───────────────────────────────────────────────────

@Composable
private fun DashboardContent(
    data: DashboardData,
    onNavigate: (String) -> Unit,
) {
    LazyColumn(
        contentPadding = PaddingValues(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingLg),
    ) {
        // 8 KPI stat cards in an adaptive grid.
        item {
            KpiGrid(data = data)
        }

        // Yesterday summary strip.
        item {
            YesterdayStrip(data = data)
        }

        // 30-day revenue trend chart.
        item {
            RevenueTrendCard(trendPoints = data.revenueTrend)
        }

        // Quick-action shortcuts.
        item {
            QuickActionsRow(onNavigate = onNavigate)
        }
    }
}

// ─── KPI grid ─────────────────────────────────────────────────────────────────

private data class KpiItem(
    val label: String,
    val value: String,
    val icon: ImageVector,
    val accentColor: Color,
)

@Composable
private fun KpiGrid(data: DashboardData) {
    val items = listOf(
        KpiItem("Today's Visits",         data.todayVisits.toString(),
            Icons.Default.CalendarMonth,    Color(0xFF3B82F6)),
        KpiItem("Completed",              data.completedVisits.toString(),
            Icons.Default.CheckCircle,      WellnessSuccess),
        KpiItem("Revenue MTD",            formatRevenue(data.revenueMonth),
            Icons.Default.TrendingUp,       WellnessPrimary),
        KpiItem("Occupancy",              "${data.occupancyPercent.toInt()}%",
            Icons.Default.Schedule,         WellnessWarning),
        KpiItem("New Leads",              data.newLeads.toString(),
            Icons.Default.Group,            Color(0xFF8B5CF6)),
        KpiItem("Pending Approvals",      data.pendingApprovals.toString(),
            Icons.Default.PendingActions,   WellnessAccent),
        KpiItem("Treatment Plans",        data.activeTreatmentPlans.toString(),
            Icons.Default.MedicalServices,  Color(0xFF6366F1)),
        KpiItem("No-Show Risk",           data.noShowRisk.toString(),
            Icons.Default.Warning,          MaterialTheme.colorScheme.error),
    )

    LazyVerticalGrid(
        columns             = GridCells.Adaptive(minSize = Dimens.KpiCardMinWidth),
        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        verticalArrangement   = Arrangement.spacedBy(Dimens.SpacingMd),
        // The grid is inside a LazyColumn so we disable its own scrolling.
        userScrollEnabled   = false,
        modifier            = Modifier.height(
            // Calculate fixed height: 2 rows of 110.dp cards + 1 gap row.
            (110.dp * 2) + Dimens.SpacingMd,
        ),
    ) {
        items(items) { kpi ->
            KpiCard(kpi = kpi)
        }
    }
}

@Composable
private fun KpiCard(kpi: KpiItem) {
    WellnessCard(modifier = Modifier.height(110.dp)) {
        Column(
            modifier            = Modifier
                .fillMaxSize()
                .padding(Dimens.SpacingMd),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier          = Modifier
                        .size(32.dp)
                        .background(
                            color = kpi.accentColor.copy(alpha = 0.12f),
                            shape = MaterialTheme.shapes.small,
                        ),
                    contentAlignment  = Alignment.Center,
                ) {
                    Icon(
                        imageVector        = kpi.icon,
                        contentDescription = null,
                        tint               = kpi.accentColor,
                        modifier           = Modifier.size(18.dp),
                    )
                }
            }
            Column {
                Text(
                    text  = kpi.value,
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text  = kpi.label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

// ─── Yesterday strip ──────────────────────────────────────────────────────────

@Composable
private fun YesterdayStrip(data: DashboardData) {
    Column {
        Text(
            text  = "Yesterday",
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.height(Dimens.SpacingSm))
        Row(
            modifier              = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            WellnessCard(modifier = Modifier.weight(1f)) {
                Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
                    Text(
                        text  = formatRevenue(data.yesterdayRevenue),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        text  = "Revenue",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            WellnessCard(modifier = Modifier.weight(1f)) {
                Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
                    Text(
                        text  = data.yesterdayVisits.toString(),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        text  = "Visits",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

// ─── Revenue trend chart ──────────────────────────────────────────────────────

@Composable
private fun RevenueTrendCard(trendPoints: List<RevenueTrendPoint>) {
    WellnessCard {
        Column(modifier = Modifier.padding(Dimens.SpacingLg)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector        = Icons.Default.TrendingUp,
                    contentDescription = null,
                    tint               = WellnessPrimary,
                    modifier           = Modifier.size(18.dp),
                )
                Spacer(modifier = Modifier.width(Dimens.SpacingSm))
                Text(
                    text  = "30-Day Revenue Trend",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
            }

            Spacer(modifier = Modifier.height(Dimens.SpacingMd))

            if (trendPoints.isNotEmpty()) {
                val modelProducer = remember(trendPoints) {
                    CartesianChartModelProducer().also { producer ->
                        producer.runTransaction {
                            lineSeries { series(trendPoints.map { it.amount.toFloat() }) }
                        }
                    }
                }
                CartesianChartHost(
                    chart = rememberCartesianChart(
                        rememberLineCartesianLayer(),
                    ),
                    modelProducer = modelProducer,
                    modifier      = Modifier
                        .fillMaxWidth()
                        .height(160.dp),
                )
            } else {
                Box(
                    modifier         = Modifier
                        .fillMaxWidth()
                        .height(160.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text  = "No trend data available",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

// ─── Quick actions ────────────────────────────────────────────────────────────

private data class QuickAction(
    val label: String,
    val icon: ImageVector,
    val route: String,
)

@Composable
private fun QuickActionsRow(onNavigate: (String) -> Unit) {
    val actions = listOf(
        QuickAction("Patients",  Icons.Default.Group,          "patients"),
        QuickAction("Calendar",  Icons.Default.CalendarMonth,  "calendar"),
        QuickAction("Reports",   Icons.Default.TrendingUp,     "reports"),
    )

    Column {
        Text(
            text  = "Quick Actions",
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.height(Dimens.SpacingSm))
        Row(
            modifier              = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            actions.forEach { action ->
                WellnessCard(
                    modifier = Modifier.weight(1f),
                    onClick  = { onNavigate(action.route) },
                ) {
                    Column(
                        modifier            = Modifier
                            .padding(Dimens.SpacingMd)
                            .fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(
                            imageVector        = action.icon,
                            contentDescription = null,
                            tint               = WellnessPrimary,
                            modifier           = Modifier.size(24.dp),
                        )
                        Spacer(modifier = Modifier.height(Dimens.SpacingXs))
                        Text(
                            text  = action.label,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
            }
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

private fun greetingByHour(): String {
    return when (Calendar.getInstance().get(Calendar.HOUR_OF_DAY)) {
        in 0..11  -> "Good morning"
        in 12..16 -> "Good afternoon"
        else      -> "Good evening"
    }
}

private fun formatRevenue(amount: Double): String {
    return when {
        amount >= 1_000_000 -> "₹${"%.1f".format(amount / 1_000_000)}M"
        amount >= 1_000     -> "₹${"%.1f".format(amount / 1_000)}K"
        else                -> "₹${"%.0f".format(amount)}"
    }
}

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "DashboardScreen – loaded", showBackground = true)
@Composable
private fun DashboardScreenPreview() {
    WellnessTheme {
        DashboardContent(
            data = DashboardData(
                todayVisits          = 24,
                completedVisits      = 18,
                revenueMonth         = 485000.0,
                occupancyPercent     = 78.5,
                newLeads             = 12,
                pendingApprovals     = 3,
                activeTreatmentPlans = 41,
                noShowRisk           = 2,
                yesterdayRevenue     = 32500.0,
                yesterdayVisits      = 22,
                patientTotal         = 1842,
                serviceTotal         = 38,
                revenueTrend         = emptyList(),
            ),
            onNavigate = {},
        )
    }
}

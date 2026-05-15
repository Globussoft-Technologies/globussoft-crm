package com.globussoft.wellness.feature.crm.presentation.dashboard

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AttachMoney
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.TrendingUp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.domain.model.Deal
import com.globussoft.wellness.core.domain.model.DealStats

// ─── Public composable ────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CrmDashboardScreen(
    viewModel: CrmDashboardViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("CRM Dashboard") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick          = { /* no-op */ },
                containerColor   = GenericPrimary,
                contentColor     = Color.White,
            ) {
                Icon(Icons.Default.Add, contentDescription = "Add Deal")
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && (state.stats != null || state.recentDeals.isNotEmpty()),
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            when {
                state.isLoading && state.stats == null -> {
                    ShimmerList(itemCount = 6, modifier = Modifier.fillMaxSize())
                }
                state.error != null && state.stats == null -> {
                    ErrorState(
                        message  = state.error ?: "Failed to load CRM data",
                        onRetry  = { viewModel.refresh() },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                else -> {
                    DashboardContent(
                        stats       = state.stats,
                        recentDeals = state.recentDeals,
                    )
                }
            }
        }
    }
}

// ─── Content ──────────────────────────────────────────────────────────────────

@Composable
private fun DashboardContent(
    stats: DealStats?,
    recentDeals: List<Deal>,
) {
    LazyColumn(
        contentPadding      = PaddingValues(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingLg),
    ) {
        // KPI cards row
        if (stats != null) {
            item { KpiRow(stats = stats) }
        }

        // Section header
        item {
            Text(
                text       = "Recent Deals",
                style      = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color      = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        if (recentDeals.isEmpty()) {
            item {
                EmptyState(
                    message  = "No deals yet. Tap + to create your first deal.",
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        } else {
            items(recentDeals) { deal ->
                DealCard(deal = deal)
            }
        }
    }
}

// ─── KPI Row ──────────────────────────────────────────────────────────────────

private data class KpiItem(
    val label: String,
    val value: String,
    val icon: ImageVector,
    val accentColor: Color,
)

@Composable
private fun KpiRow(stats: DealStats) {
    val items = listOf(
        KpiItem(
            label       = "Closed Revenue",
            value       = formatCurrency(stats.wonValue),
            icon        = Icons.Default.AttachMoney,
            accentColor = GenericPrimary,
        ),
        KpiItem(
            label       = "Expected",
            value       = formatCurrency(stats.expectedValue),
            icon        = Icons.Default.TrendingUp,
            accentColor = GenericAccent,
        ),
        KpiItem(
            label       = "Total Deals",
            value       = stats.totalDeals.toString(),
            icon        = Icons.Default.BarChart,
            accentColor = Color(0xFF8B5CF6),
        ),
        KpiItem(
            label       = "Conversion",
            value       = formatPercent(stats.conversionRate),
            icon        = Icons.Default.SwapHoriz,
            accentColor = Color(0xFFF59E0B),
        ),
    )

    Row(
        modifier              = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
    ) {
        items.forEach { kpi ->
            KpiCard(kpi = kpi, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun KpiCard(kpi: KpiItem, modifier: Modifier = Modifier) {
    WellnessCard(modifier = modifier) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(3.dp)
                .background(kpi.accentColor),
        )
        Column(
            modifier            = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Box(
                modifier         = Modifier
                    .height(28.dp)
                    .width(28.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(kpi.accentColor.copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector        = kpi.icon,
                    contentDescription = null,
                    tint               = kpi.accentColor,
                    modifier           = Modifier
                        .height(16.dp)
                        .width(16.dp),
                )
            }
            Text(
                text       = kpi.value,
                style      = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color      = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text  = kpi.label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// ─── Deal Card ────────────────────────────────────────────────────────────────

@Composable
private fun DealCard(deal: Deal) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text       = deal.title,
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier   = Modifier.weight(1f),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text       = formatCurrency(deal.amount),
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color      = GenericPrimary,
                )
            }

            Row(
                verticalAlignment     = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                StageChip(stage = deal.stage)
                deal.contactName?.let { cName ->
                    Text(
                        text  = cName,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            deal.expectedClose?.let { close ->
                Text(
                    text  = "Close: $close",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun StageChip(stage: String) {
    val color = stageColor(stage)
    SuggestionChip(
        onClick = {},
        label   = {
            Text(
                text  = stage,
                style = MaterialTheme.typography.labelSmall,
            )
        },
        colors = SuggestionChipDefaults.suggestionChipColors(
            containerColor = color.copy(alpha = 0.15f),
            labelColor     = color,
        ),
        border = SuggestionChipDefaults.suggestionChipBorder(
            enabled         = true,
            borderColor     = color.copy(alpha = 0.4f),
            borderWidth     = 1.dp,
        ),
    )
}

private fun stageColor(stage: String): Color = when (stage.lowercase()) {
    "qualified", "proposal"    -> Color(0xFF3B82F6)
    "negotiation"              -> Color(0xFFF59E0B)
    "won"                      -> Color(0xFF10B981)
    "lost"                     -> Color(0xFFEF4444)
    else                       -> Color(0xFF8B5CF6)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

private fun formatCurrency(value: Double): String = "$%.0f".format(value)

private fun formatPercent(value: Double): String = "%.0f%%".format(value * 100)

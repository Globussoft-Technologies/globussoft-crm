package com.globussoft.wellness.feature.crm.presentation.reports

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
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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

private val TAB_LABELS = listOf("Overview", "Agents", "Win/Loss", "Funnel")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReportsScreen(
    viewModel: ReportsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Reports") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            TabRow(selectedTabIndex = state.selectedTab) {
                TAB_LABELS.forEachIndexed { index, label ->
                    Tab(
                        selected = state.selectedTab == index,
                        onClick  = { viewModel.selectTab(index) },
                        text     = { Text(label) },
                    )
                }
            }

            // Date range filter
            Row(
                modifier              = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value         = state.fromDate,
                    onValueChange = { viewModel.setFromDate(it) },
                    label         = { Text("From", style = MaterialTheme.typography.labelSmall) },
                    modifier      = Modifier.weight(1f),
                    singleLine    = true,
                    placeholder   = { Text("YYYY-MM-DD") },
                )
                OutlinedTextField(
                    value         = state.toDate,
                    onValueChange = { viewModel.setToDate(it) },
                    label         = { Text("To", style = MaterialTheme.typography.labelSmall) },
                    modifier      = Modifier.weight(1f),
                    singleLine    = true,
                    placeholder   = { Text("YYYY-MM-DD") },
                )
            }

            PullToRefreshBox(
                isRefreshing = state.isLoading,
                onRefresh    = { viewModel.refresh() },
                modifier     = Modifier.fillMaxSize(),
            ) {
                when {
                    state.isLoading && state.overview.isEmpty() -> {
                        ShimmerList(
                            itemCount = 4,
                            modifier  = Modifier.padding(Dimens.SpacingLg),
                        )
                    }
                    state.error != null -> {
                        ErrorState(
                            message  = state.error!!,
                            onRetry  = { viewModel.refresh() },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    else -> {
                        when (state.selectedTab) {
                            0    -> OverviewTab(overview = state.overview)
                            1    -> AgentsTab(agents = state.agentPerformance)
                            2    -> WinLossTab(winLoss = state.winLoss)
                            else -> FunnelTab(funnel = state.funnel)
                        }
                    }
                }
            }
        }
    }
}

// ── Tab 0 — Overview ──────────────────────────────────────────────────────────

@Composable
private fun OverviewTab(overview: Map<String, Any>) {
    val totalDeals      = overview["totalDeals"]?.toString()      ?: "—"
    val closedRevenue   = overview["closedRevenue"]?.toString()   ?: "—"
    val newContacts     = overview["newContacts"]?.toString()     ?: "—"
    val conversionRate  = overview["conversionRate"]?.toString()  ?: "—"

    LazyColumn(
        modifier            = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
        contentPadding      = PaddingValues(Dimens.SpacingLg),
    ) {
        item { KpiCard(label = "Total Deals",      value = totalDeals) }
        item { KpiCard(label = "Closed Revenue",   value = closedRevenue) }
        item { KpiCard(label = "New Contacts",     value = newContacts) }
        item { KpiCard(label = "Conversion Rate",  value = conversionRate) }
    }
}

@Composable
private fun KpiCard(label: String, value: String, modifier: Modifier = Modifier) {
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier                = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            horizontalArrangement   = Arrangement.SpaceBetween,
            verticalAlignment       = Alignment.CenterVertically,
        ) {
            Text(
                text  = label,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text       = value,
                style      = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color      = GenericPrimary,
            )
        }
    }
}

// ── Tab 1 — Agents ─────────────────────────────────────────────────────────────

@Composable
private fun AgentsTab(agents: List<Map<String, Any>>) {
    if (agents.isEmpty()) {
        EmptyState(
            message  = "No agent performance data",
            modifier = Modifier.fillMaxSize(),
        )
        return
    }

    LazyColumn(
        modifier            = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
        contentPadding      = PaddingValues(Dimens.SpacingLg),
    ) {
        items(agents) { agent ->
            AgentCard(agent = agent)
        }
    }
}

@Composable
private fun AgentCard(agent: Map<String, Any>, modifier: Modifier = Modifier) {
    val name       = agent["name"]?.toString()       ?: "Unknown"
    val dealsWon   = agent["dealsWon"]?.toString()   ?: "0"
    val revenue    = agent["revenue"]?.toString()    ?: "—"
    val callsMade  = agent["callsMade"]?.toString()  ?: "0"

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
        ) {
            Text(
                text  = name,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(Dimens.SpacingSm))
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                AgentMetric(label = "Deals Won",   value = dealsWon,  modifier = Modifier.weight(1f))
                AgentMetric(label = "Revenue",     value = revenue,   modifier = Modifier.weight(1f))
                AgentMetric(label = "Calls Made",  value = callsMade, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun AgentMetric(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier) {
        Text(
            text  = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text  = value,
            style = MaterialTheme.typography.bodyMedium,
            color = GenericAccent,
            fontWeight = FontWeight.Medium,
        )
    }
}

// ── Tab 2 — Win/Loss ──────────────────────────────────────────────────────────

@Composable
private fun WinLossTab(winLoss: Map<String, Any>) {
    val winRate     = winLoss["winRate"]?.toString()    ?: "—"
    @Suppress("UNCHECKED_CAST")
    val lostReasons = (winLoss["lostReasons"] as? List<Map<String, Any>>) ?: emptyList()

    LazyColumn(
        modifier            = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
        contentPadding      = PaddingValues(Dimens.SpacingLg),
    ) {
        item {
            WellnessCard(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(Dimens.SpacingLg)) {
                    Text(
                        text  = "Win Rate",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text       = winRate,
                        style      = MaterialTheme.typography.headlineMedium,
                        color      = GenericAccent,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }

        if (lostReasons.isNotEmpty()) {
            item {
                Spacer(Modifier.height(Dimens.SpacingXs))
                Text(
                    text  = "Top Lost Reasons",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Dimens.SpacingXs),
                )
            }
            items(lostReasons) { reason ->
                WellnessCard(modifier = Modifier.fillMaxWidth()) {
                    Row(
                        modifier              = Modifier
                            .fillMaxWidth()
                            .padding(Dimens.SpacingLg),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment     = Alignment.CenterVertically,
                    ) {
                        Text(
                            text     = reason["reason"]?.toString() ?: "Unknown",
                            style    = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            text  = reason["count"]?.toString() ?: "",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.error,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }
        } else {
            item {
                EmptyState(
                    message  = "No lost reason data",
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

// ── Tab 3 — Funnel ────────────────────────────────────────────────────────────

@Composable
private fun FunnelTab(funnel: Map<String, Any>) {
    val leads    = funnel["leads"]?.toString()    ?: "—"
    val contacts = funnel["contacts"]?.toString() ?: "—"
    val deals    = funnel["deals"]?.toString()    ?: "—"
    val won      = funnel["won"]?.toString()      ?: "—"

    val stages = listOf(
        "Leads"    to leads,
        "Contacts" to contacts,
        "Deals"    to deals,
        "Won"      to won,
    )

    LazyColumn(
        modifier            = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(0.dp),
        contentPadding      = PaddingValues(Dimens.SpacingLg),
    ) {
        item {
            WellnessCard(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(Dimens.SpacingLg)) {
                    stages.forEachIndexed { index, (stageName, stageCount) ->
                        FunnelStageRow(label = stageName, count = stageCount)
                        if (index < stages.lastIndex) {
                            Box(
                                modifier      = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = Dimens.SpacingXs),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    imageVector        = Icons.Default.ArrowDownward,
                                    contentDescription = null,
                                    tint               = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier           = Modifier.size(18.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FunnelStageRow(label: String, count: String, modifier: Modifier = Modifier) {
    Row(
        modifier          = modifier
            .fillMaxWidth()
            .padding(vertical = Dimens.SpacingSm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier          = Modifier.width(120.dp),
            contentAlignment  = Alignment.CenterStart,
        ) {
            Text(
                text  = label,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        HorizontalDivider(
            modifier  = Modifier
                .weight(1f)
                .padding(horizontal = Dimens.SpacingSm),
            color     = MaterialTheme.colorScheme.outlineVariant,
        )
        Text(
            text       = count,
            style      = MaterialTheme.typography.titleSmall,
            color      = GenericPrimary,
            fontWeight = FontWeight.Bold,
        )
    }
}

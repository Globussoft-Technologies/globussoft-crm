package com.globussoft.wellness.feature.admin.presentation.perlocation

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.feature.admin.domain.repository.LocationKpi

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PerLocationScreen(viewModel: PerLocationViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Per-Location", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        if (state.columns.isNotEmpty()) {
                            Text("${state.columns.size} locations", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.columns.isNotEmpty(),
            onRefresh    = viewModel::refresh,
            modifier     = Modifier.fillMaxSize().padding(padding),
        ) {
            when {
                state.isLoading && state.columns.isEmpty() ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("Loading locations…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                state.error != null && state.columns.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = viewModel::refresh, modifier = Modifier.fillMaxSize())
                state.columns.isEmpty() ->
                    EmptyState(message = "No active locations found.", icon = Icons.Default.LocationOn, modifier = Modifier.fillMaxSize())
                else -> LocationColumnsLayout(state.columns)
            }
        }
    }
}

@Composable
private fun LocationColumnsLayout(columns: List<LocationKpi>) {
    Row(
        modifier              = Modifier
            .fillMaxSize()
            .horizontalScroll(rememberScrollState())
            .padding(Dimens.SpacingLg),
        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
    ) {
        columns.forEach { kpi ->
            LocationColumn(kpi, modifier = Modifier.width(220.dp).fillMaxHeight())
        }
    }
}

@Composable
private fun LocationColumn(kpi: LocationKpi, modifier: Modifier = Modifier) {
    WellnessCard(modifier = modifier) {
        Column(
            modifier              = Modifier
                .fillMaxSize()
                .padding(Dimens.SpacingMd)
                .verticalScroll(rememberScrollState()),
            verticalArrangement   = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            // Header
            Text(
                text       = kpi.locationName,
                style      = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color      = WellnessPrimary,
            )
            if (!kpi.locationCity.isNullOrBlank()) {
                Text(kpi.locationCity, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            HorizontalDivider()

            KpiRow("Today's Visits",  "${kpi.todayVisits}")
            KpiRow("Completed",       "${kpi.todayCompleted}")
            KpiRow("Expected Revenue","₹${"%,d".format(kpi.todayExpectedRevenue)}")
            KpiRow("Occupancy",       "${kpi.occupancyPct}%")
            KpiRow("New Leads",       "${kpi.newLeads}")

            HorizontalDivider()

            KpiRow("Total Patients",  "${kpi.totalPatients}")
        }
    }
}

@Composable
private fun KpiRow(label: String, value: String) {
    Row(
        modifier              = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
    }
}

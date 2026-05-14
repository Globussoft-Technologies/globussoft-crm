package com.globussoft.wellness.feature.reports.presentation

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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FileDownload
import androidx.compose.material.icons.filled.TrendingUp
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.patrykandpatrick.vico.compose.cartesian.CartesianChartHost
import com.patrykandpatrick.vico.compose.cartesian.layer.rememberColumnCartesianLayer
import com.patrykandpatrick.vico.compose.cartesian.rememberCartesianChart
import com.patrykandpatrick.vico.core.cartesian.data.CartesianChartModelProducer
import com.patrykandpatrick.vico.core.cartesian.data.columnSeries
import com.globussoft.wellness.core.common.utils.millisToIsoDate
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessTabStrip
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessSuccess
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.globussoft.wellness.core.domain.model.AttributionData
import com.globussoft.wellness.core.domain.model.PerLocation
import com.globussoft.wellness.core.domain.model.PerProfessional
import com.globussoft.wellness.core.domain.model.PnlByService
import kotlinx.coroutines.launch

private val REPORT_TABS = listOf("P&L", "Per Professional", "Per Location", "Attribution")

// ─── Public composable ────────────────────────────────────────────────────────

/**
 * Reports screen showing four analytics tabs: P&L, Per Professional, Per Location,
 * and Attribution.  Supports a configurable date range and CSV export shortcut.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReportsScreen(
    viewModel: ReportsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is ReportsEffect.ShowSnackbar -> scope.launch {
                    snackbarHostState.showSnackbar(effect.message)
                }
            }
        }
    }

    // Sync pager ↔ tab strip bidirectionally.
    val pagerState = rememberPagerState(
        initialPage  = state.selectedTabIndex,
        pageCount    = { REPORT_TABS.size },
    )

    // When pager settles on a page, inform the ViewModel.
    LaunchedEffect(pagerState) {
        snapshotFlow { pagerState.currentPage }
            .collect { page -> viewModel.onEvent(ReportsEvent.TabSelected(page)) }
    }

    // When ViewModel changes tab (e.g. initial state), scroll the pager.
    LaunchedEffect(state.selectedTabIndex) {
        if (pagerState.currentPage != state.selectedTabIndex) {
            pagerState.animateScrollToPage(state.selectedTabIndex)
        }
    }

    Scaffold(
        snackbarHost     = { SnackbarHost(snackbarHostState) },
        topBar           = {
            TopAppBar(
                title  = { Text("Reports", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) },
                actions = {
                    IconButton(
                        onClick  = { viewModel.onEvent(ReportsEvent.ExportCsv) },
                        enabled  = !state.isExporting,
                    ) {
                        Icon(
                            imageVector        = Icons.Default.FileDownload,
                            contentDescription = "Export CSV",
                            tint               = WellnessPrimary,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            // Date range row.
            DateRangeRow(
                fromDate    = state.fromDate,
                toDate      = state.toDate,
                onFromDate  = { viewModel.onEvent(ReportsEvent.FromDateChanged(it)) },
                onToDate    = { viewModel.onEvent(ReportsEvent.ToDateChanged(it)) },
                modifier    = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
            )

            // Tab strip.
            WellnessTabStrip(
                tabs          = REPORT_TABS,
                selectedIndex = state.selectedTabIndex,
                onTabSelected = { viewModel.onEvent(ReportsEvent.TabSelected(it)) },
                modifier      = Modifier.fillMaxWidth(),
            )

            // Pager content.
            PullToRefreshBox(
                isRefreshing = state.isLoading && hasData(state),
                onRefresh    = { viewModel.onEvent(ReportsEvent.Refresh) },
                modifier     = Modifier.fillMaxSize(),
            ) {
                when {
                    state.isLoading && !hasData(state) -> {
                        ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                    }
                    state.error != null && !hasData(state) -> {
                        ErrorState(
                            message  = state.error!!,
                            onRetry  = { viewModel.onEvent(ReportsEvent.Refresh) },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    else -> {
                        HorizontalPager(
                            state    = pagerState,
                            modifier = Modifier.fillMaxSize(),
                        ) { page ->
                            when (page) {
                                0 -> PnlTab(data = state.pnlData, isLoading = state.isLoading && state.selectedTabIndex == 0)
                                1 -> PerProTab(data = state.perProData, isLoading = state.isLoading && state.selectedTabIndex == 1)
                                2 -> PerLocationTab(data = state.perLocationData, isLoading = state.isLoading && state.selectedTabIndex == 2)
                                3 -> AttributionTab(data = state.attributionData, isLoading = state.isLoading && state.selectedTabIndex == 3)
                                else -> Box(modifier = Modifier.fillMaxSize())
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Returns true when the current tab already has data in state. */
private fun hasData(state: ReportsUiState): Boolean = when (state.selectedTabIndex) {
    0 -> state.pnlData.isNotEmpty()
    1 -> state.perProData.isNotEmpty()
    2 -> state.perLocationData.isNotEmpty()
    3 -> state.attributionData.isNotEmpty()
    else -> false
}

// ─── Date range row ───────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateRangeRow(
    fromDate: String,
    toDate: String,
    onFromDate: (String) -> Unit,
    onToDate: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var showFromPicker by remember { mutableStateOf(false) }
    var showToPicker   by remember { mutableStateOf(false) }

    Row(
        modifier              = modifier,
        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        verticalAlignment     = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value         = fromDate,
            onValueChange = {},
            readOnly      = true,
            label         = { Text("From") },
            modifier      = Modifier
                .weight(1f),
            singleLine    = true,
            onClick       = { showFromPicker = true },
        )
        OutlinedTextField(
            value         = toDate,
            onValueChange = {},
            readOnly      = true,
            label         = { Text("To") },
            modifier      = Modifier
                .weight(1f),
            singleLine    = true,
            onClick       = { showToPicker = true },
        )
    }

    if (showFromPicker) {
        WellnessDatePickerDialog(
            initialIsoDate = fromDate,
            onDateSelected = { millis ->
                showFromPicker = false
                if (millis != null) onFromDate(millisToIsoDate(millis))
            },
            onDismiss = { showFromPicker = false },
        )
    }
    if (showToPicker) {
        WellnessDatePickerDialog(
            initialIsoDate = toDate,
            onDateSelected = { millis ->
                showToPicker = false
                if (millis != null) onToDate(millisToIsoDate(millis))
            },
            onDismiss = { showToPicker = false },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WellnessDatePickerDialog(
    initialIsoDate: String,
    onDateSelected: (Long?) -> Unit,
    onDismiss: () -> Unit,
) {
    val state = rememberDatePickerState()
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = { onDateSelected(state.selectedDateMillis) }) {
                Text("OK")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    ) {
        DatePicker(state = state)
    }
}

// ─── Tab 0: P&L by Service ────────────────────────────────────────────────────

@Composable
private fun PnlTab(data: List<PnlByService>, isLoading: Boolean) {
    when {
        isLoading       -> ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
        data.isEmpty()  -> EmptyState(
            message  = "No P&L data for the selected period.",
            modifier = Modifier.fillMaxSize(),
        )
        else -> {
            val totalRevenue = data.sumOf { it.amount }
            val totalVisits  = data.sumOf { it.visits }

            LazyColumn(
                contentPadding = PaddingValues(Dimens.SpacingLg),
                verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                // Summary cards.
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    ) {
                        SummaryKpiCard(
                            label = "Total Revenue",
                            value = formatRupee(totalRevenue),
                            modifier = Modifier.weight(1f),
                        )
                        SummaryKpiCard(
                            label = "Total Visits",
                            value = totalVisits.toString(),
                            modifier = Modifier.weight(1f),
                        )
                    }
                }

                // Bar chart.
                item {
                    PnlBarChart(data = data)
                }

                // Table header.
                item {
                    ReportTableHeader(columns = listOf("Service", "Visits", "Revenue", "Margin"))
                }

                // Table rows.
                items(data) { row ->
                    PnlTableRow(row = row)
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                }
            }
        }
    }
}

@Composable
private fun PnlBarChart(data: List<PnlByService>) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
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
                    text  = "Revenue by Service",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            Spacer(modifier = Modifier.height(Dimens.SpacingMd))
            val modelProducer = remember(data) { CartesianChartModelProducer() }
            LaunchedEffect(data) {
                modelProducer.runTransaction {
                    columnSeries { series(data.map { it.amount.toFloat() }) }
                }
            }
            CartesianChartHost(
                chart         = rememberCartesianChart(rememberColumnCartesianLayer()),
                modelProducer = modelProducer,
                modifier      = Modifier
                    .fillMaxWidth()
                    .height(180.dp),
            )
        }
    }
}

@Composable
private fun PnlTableRow(row: PnlByService) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = Dimens.SpacingSm, horizontal = Dimens.SpacingXs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text     = row.serviceName,
            style    = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(2f),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text      = row.visits.toString(),
            style     = MaterialTheme.typography.bodySmall,
            modifier  = Modifier.weight(1f),
            textAlign = TextAlign.End,
        )
        Text(
            text      = formatRupee(row.amount),
            style     = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
            modifier  = Modifier.weight(1.2f),
            textAlign = TextAlign.End,
        )
        val rowMargin = row.margin
        Text(
            text      = rowMargin?.let { "${"%.0f".format(it * 100)}%" } ?: "—",
            style     = MaterialTheme.typography.bodySmall,
            color     = if (rowMargin != null && rowMargin > 0) WellnessSuccess
                        else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier  = Modifier.weight(1.2f),
            textAlign = TextAlign.End,
        )
    }
}

// ─── Tab 1: Per Professional ──────────────────────────────────────────────────

@Composable
private fun PerProTab(data: List<PerProfessional>, isLoading: Boolean) {
    when {
        isLoading      -> ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
        data.isEmpty() -> EmptyState(
            message  = "No professional data for the selected period.",
            modifier = Modifier.fillMaxSize(),
        )
        else -> {
            LazyColumn(
                contentPadding      = PaddingValues(Dimens.SpacingLg),
                verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                item {
                    PerProBarChart(data = data)
                }
                item {
                    ReportTableHeader(columns = listOf("Doctor", "Visits", "Revenue", "Util%"))
                }
                items(data) { row ->
                    PerProTableRow(row = row)
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                }
            }
        }
    }
}

@Composable
private fun PerProBarChart(data: List<PerProfessional>) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingLg)) {
            Text(
                text       = "Revenue per Professional",
                style      = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(modifier = Modifier.height(Dimens.SpacingMd))
            val modelProducer = remember(data) { CartesianChartModelProducer() }
            LaunchedEffect(data) {
                modelProducer.runTransaction {
                    columnSeries { series(data.map { it.revenue.toFloat() }) }
                }
            }
            CartesianChartHost(
                chart         = rememberCartesianChart(rememberColumnCartesianLayer()),
                modelProducer = modelProducer,
                modifier      = Modifier
                    .fillMaxWidth()
                    .height(180.dp),
            )
        }
    }
}

@Composable
private fun PerProTableRow(row: PerProfessional) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = Dimens.SpacingSm, horizontal = Dimens.SpacingXs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text     = row.doctorName,
            style    = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(2f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text      = row.visits.toString(),
            style     = MaterialTheme.typography.bodySmall,
            modifier  = Modifier.weight(1f),
            textAlign = TextAlign.End,
        )
        Text(
            text      = formatRupee(row.revenue),
            style     = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
            modifier  = Modifier.weight(1.2f),
            textAlign = TextAlign.End,
        )
        Text(
            text      = row.utilizationPercent?.let { "${"%.0f".format(it)}%" } ?: "—",
            style     = MaterialTheme.typography.bodySmall,
            modifier  = Modifier.weight(1f),
            textAlign = TextAlign.End,
        )
    }
}

// ─── Tab 2: Per Location ──────────────────────────────────────────────────────

@Composable
private fun PerLocationTab(data: List<PerLocation>, isLoading: Boolean) {
    when {
        isLoading      -> ShimmerList(itemCount = 3, modifier = Modifier.fillMaxSize())
        data.isEmpty() -> EmptyState(
            message  = "No location data for the selected period.",
            modifier = Modifier.fillMaxSize(),
        )
        else -> {
            LazyColumn(
                contentPadding      = PaddingValues(Dimens.SpacingLg),
                verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                // KPI cards row per location (grid-style).
                items(data) { loc ->
                    LocationKpiCard(loc = loc)
                }

                // Table header.
                item {
                    Spacer(modifier = Modifier.height(Dimens.SpacingSm))
                    ReportTableHeader(columns = listOf("Location", "Visits", "Revenue"))
                }

                items(data) { loc ->
                    PerLocationTableRow(row = loc)
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                }
            }
        }
    }
}

@Composable
private fun LocationKpiCard(loc: PerLocation) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            Column {
                Text(
                    text       = loc.locationName,
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(modifier = Modifier.height(Dimens.SpacingXs))
                Text(
                    text  = "${loc.visits} visits",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text       = formatRupee(loc.revenue),
                    style      = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color      = WellnessPrimary,
                )
                Text(
                    text  = "Revenue",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun PerLocationTableRow(row: PerLocation) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = Dimens.SpacingSm, horizontal = Dimens.SpacingXs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text     = row.locationName,
            style    = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(2f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text      = row.visits.toString(),
            style     = MaterialTheme.typography.bodySmall,
            modifier  = Modifier.weight(1f),
            textAlign = TextAlign.End,
        )
        Text(
            text       = formatRupee(row.revenue),
            style      = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
            modifier   = Modifier.weight(1.3f),
            textAlign  = TextAlign.End,
        )
    }
}

// ─── Tab 3: Attribution ───────────────────────────────────────────────────────

@Composable
private fun AttributionTab(data: List<AttributionData>, isLoading: Boolean) {
    when {
        isLoading      -> ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
        data.isEmpty() -> EmptyState(
            message  = "No attribution data for the selected period.",
            modifier = Modifier.fillMaxSize(),
        )
        else -> {
            LazyColumn(
                contentPadding      = PaddingValues(Dimens.SpacingLg),
                verticalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
            ) {
                item {
                    ReportTableHeader(columns = listOf("Channel", "Leads", "Conv.", "ROI"))
                }
                items(data) { row ->
                    AttributionTableRow(row = row)
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                }
            }
        }
    }
}

@Composable
private fun AttributionTableRow(row: AttributionData) {
    val convRate = if (row.leads > 0) row.conversions.toFloat() / row.leads.toFloat() else 0f

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = Dimens.SpacingSm, horizontal = Dimens.SpacingXs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(2f)) {
            Text(
                text     = row.channel,
                style    = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            SuggestionChip(
                onClick = {},
                label   = {
                    Text(
                        text  = "${"%.0f".format(convRate * 100)}% CVR",
                        style = MaterialTheme.typography.labelSmall,
                    )
                },
                colors  = SuggestionChipDefaults.suggestionChipColors(
                    containerColor = WellnessPrimary.copy(alpha = 0.10f),
                    labelColor     = WellnessPrimary,
                ),
            )
        }
        Text(
            text      = row.leads.toString(),
            style     = MaterialTheme.typography.bodySmall,
            modifier  = Modifier.weight(0.7f),
            textAlign = TextAlign.End,
        )
        Text(
            text      = row.conversions.toString(),
            style     = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
            modifier  = Modifier.weight(0.7f),
            textAlign = TextAlign.End,
        )
        val rowRoi = row.roi
        Text(
            text      = rowRoi?.let { "${"%.1f".format(it)}x" } ?: "—",
            style     = MaterialTheme.typography.bodySmall,
            color     = if (rowRoi != null && rowRoi >= 1.0) WellnessSuccess
                        else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier  = Modifier.weight(0.8f),
            textAlign = TextAlign.End,
        )
    }
}

// ─── Shared sub-components ────────────────────────────────────────────────────

@Composable
private fun SummaryKpiCard(label: String, value: String, modifier: Modifier = Modifier) {
    WellnessCard(modifier = modifier) {
        Column(
            modifier = Modifier.padding(Dimens.SpacingMd),
        ) {
            Text(
                text       = value,
                style      = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                color      = WellnessPrimary,
            )
            Text(
                text  = label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ReportTableHeader(columns: List<String>) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        shape = RoundedCornerShape(topStart = Dimens.CornerSmall, topEnd = Dimens.CornerSmall),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Dimens.SpacingXs, vertical = Dimens.SpacingSm),
        ) {
            columns.forEachIndexed { idx, col ->
                Text(
                    text       = col,
                    style      = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                    color      = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier   = Modifier.weight(if (idx == 0) 2f else if (col.length > 5) 1.2f else 1f),
                    textAlign  = if (idx == 0) TextAlign.Start else TextAlign.End,
                )
            }
        }
    }
}

// ─── Number helpers ───────────────────────────────────────────────────────────

private fun formatRupee(amount: Double): String = when {
    amount >= 1_000_000 -> "₹${"%.1f".format(amount / 1_000_000)}M"
    amount >= 1_000     -> "₹${"%.1f".format(amount / 1_000)}K"
    else                -> "₹${"%.0f".format(amount)}"
}

// ─── OutlinedTextField onClick extension helper ───────────────────────────────

@Composable
private fun OutlinedTextField(
    value: String,
    onValueChange: (String) -> Unit,
    readOnly: Boolean,
    label: @Composable () -> Unit,
    modifier: Modifier,
    singleLine: Boolean,
    onClick: () -> Unit,
) {
    // Wrap with a clickable Box so the read-only field still registers taps.
    Box(modifier = modifier) {
        androidx.compose.material3.OutlinedTextField(
            value         = value,
            onValueChange = onValueChange,
            readOnly      = readOnly,
            label         = label,
            singleLine    = singleLine,
            modifier      = Modifier.fillMaxWidth(),
        )
        // Transparent overlay to capture clicks on the read-only field.
        Box(
            modifier = Modifier
                .matchParentSize()
                .background(Color.Transparent)
                .then(Modifier.fillMaxWidth()),
        ) {
            Surface(
                modifier = Modifier.matchParentSize(),
                color    = Color.Transparent,
                onClick  = onClick,
            ) {}
        }
    }
}

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "ReportsScreen – PnL tab preview", showBackground = true)
@Composable
private fun ReportsScreenPnlPreview() {
    WellnessTheme {
        val sampleData = listOf(
            PnlByService("Hair Colour", 42, 126000.0, 38000.0),
            PnlByService("Facial", 38, 95000.0, 28500.0),
            PnlByService("Massage Therapy", 55, 82500.0, 24750.0),
        )
        PnlTab(data = sampleData, isLoading = false)
    }
}

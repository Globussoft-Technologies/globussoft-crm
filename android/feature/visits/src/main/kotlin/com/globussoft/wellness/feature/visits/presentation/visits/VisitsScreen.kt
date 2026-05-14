package com.globussoft.wellness.feature.visits.presentation.visits

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.domain.model.Visit
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

// ─── Public composable ────────────────────────────────────────────────────────

/**
 * Visits log screen.
 *
 * Shows a date-range filter bar above a paginated [LazyColumn] of visit rows.
 * Tapping a row navigates to the patient detail page.
 *
 * @param onNavigateToPatient Called with the [Visit.patientId] when a row is tapped.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VisitsScreen(
    onNavigateToPatient: (String) -> Unit,
    viewModel: VisitsViewModel = hiltViewModel(),
) {
    val state        by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHost = remember { SnackbarHostState() }
    val scope        = rememberCoroutineScope()
    val listState    = rememberLazyListState()

    // Trigger next-page load when near the bottom.
    val shouldLoadMore by remember {
        derivedStateOf {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            val totalItems  = listState.layoutInfo.totalItemsCount
            !state.isLoading && !state.hasReachedEnd && totalItems > 0 && lastVisible >= totalItems - 3
        }
    }

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is VisitsEffect.NavigateToPatient -> onNavigateToPatient(effect.patientId)
                is VisitsEffect.ShowSnackbar      -> scope.launch { snackbarHost.showSnackbar(effect.message) }
            }
        }
    }

    LaunchedEffect(shouldLoadMore) {
        if (shouldLoadMore) viewModel.onEvent(VisitsEvent.LoadNextPage)
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHost) },
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.CalendarMonth, contentDescription = null,
                            tint = WellnessPrimary, modifier = Modifier.size(22.dp))
                        Spacer(Modifier.width(Dimens.SpacingSm))
                        Text("Visits", fontWeight = FontWeight.SemiBold)
                        if (state.totalCount > 0) {
                            Spacer(Modifier.width(Dimens.SpacingXs))
                            Text(
                                text  = "(${state.totalCount})",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = Dimens.SpacingLg),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            // Date range filter bar
            DateRangeFilter(state = state, onEvent = viewModel::onEvent)

            when {
                state.isLoading && state.visits.isEmpty() ->
                    ShimmerList(itemCount = 8, modifier = Modifier.fillMaxSize())
                state.error != null && state.visits.isEmpty() -> {
                    val errorMsg = state.error ?: ""
                    ErrorState(
                        message  = errorMsg,
                        onRetry  = { viewModel.onEvent(VisitsEvent.Refresh) },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                state.visits.isEmpty() ->
                    EmptyState(
                        message  = "No visits found for the selected period.",
                        icon     = Icons.Default.CalendarMonth,
                        modifier = Modifier.fillMaxSize(),
                    )
                else -> {
                    LazyColumn(
                        state          = listState,
                        contentPadding = PaddingValues(bottom = Dimens.SpacingLg),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
                    ) {
                        items(state.visits, key = { it.id }) { visit ->
                            VisitRow(
                                visit   = visit,
                                onClick = { viewModel.onEvent(VisitsEvent.VisitClicked(visit.patientId)) },
                            )
                        }
                        if (state.isLoading) {
                            item {
                                Box(
                                    modifier         = Modifier.fillMaxWidth().padding(Dimens.SpacingLg),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    CircularProgressIndicator(color = WellnessPrimary, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
                                }
                            }
                        }
                        if (!state.hasReachedEnd && !state.isLoading && state.visits.isNotEmpty()) {
                            item {
                                Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                                    TextButton(onClick = { viewModel.onEvent(VisitsEvent.LoadNextPage) }) {
                                        Text("Load more")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ─── Date range filter ────────────────────────────────────────────────────────

@Composable
private fun DateRangeFilter(
    state: VisitsUiState,
    onEvent: (VisitsEvent) -> Unit,
) {
    WellnessCard {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
        ) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
            ) {
                WellnessTextField(
                    value         = state.fromDate,
                    onValueChange = { onEvent(VisitsEvent.FromDateChanged(it)) },
                    label         = "From (YYYY-MM-DD)",
                    placeholder   = "2026-01-01",
                    imeAction     = ImeAction.Next,
                    modifier      = Modifier.weight(1f),
                )
                WellnessTextField(
                    value         = state.toDate,
                    onValueChange = { onEvent(VisitsEvent.ToDateChanged(it)) },
                    label         = "To (YYYY-MM-DD)",
                    placeholder   = "2026-12-31",
                    imeAction     = ImeAction.Done,
                    modifier      = Modifier.weight(1f),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm)) {
                WellnessButton(
                    text     = "Apply Filter",
                    onClick  = { onEvent(VisitsEvent.ApplyFilter) },
                    icon     = Icons.Default.FilterList,
                    modifier = Modifier.weight(1f),
                )
                if (state.fromDate.isNotBlank() || state.toDate.isNotBlank()) {
                    IconButton(onClick = { onEvent(VisitsEvent.ClearFilter) }) {
                        Icon(Icons.Default.Clear, contentDescription = "Clear filter", tint = WellnessPrimary)
                    }
                }
            }
        }
    }
}

// ─── Visit row ────────────────────────────────────────────────────────────────

@Composable
private fun VisitRow(visit: Visit, onClick: () -> Unit) {
    val fmt = NumberFormat.getCurrencyInstance(Locale("en", "IN"))

    WellnessCard(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text       = visit.patientName ?: "Unknown Patient",
                    style      = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text  = visit.serviceName ?: "No service",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text  = "${formatDateTime(visit.visitDate)}  •  ${visit.doctorName ?: "—"}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                StatusBadge(status = visit.status.name)
                if (visit.amount != null) {
                    Text(
                        text  = fmt.format(visit.amount),
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Medium,
                        color = WellnessPrimary,
                    )
                }
            }
        }
    }
}

private fun formatDateTime(iso: String): String = try { iso.substring(0, 16).replace('T', ' ') } catch (_: Exception) { iso }

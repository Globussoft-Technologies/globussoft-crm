package com.globussoft.wellness.feature.admin.presentation.leads

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.People
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.feature.admin.domain.repository.LeadItem

private val STATUS_FILTERS = listOf(null, "New", "Contacted", "Qualified", "Converted", "Lost")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LeadsScreen(
    viewModel: LeadsViewModel = hiltViewModel(),
    onLeadClick: (String) -> Unit = {},
) {
    val state    by viewModel.state.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()

    val shouldLoadMore by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= state.leads.size - 4 && !state.isLoading && state.currentPage < state.totalPages
        }
    }
    LaunchedEffect(shouldLoadMore) { if (shouldLoadMore) viewModel.loadNextPage() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("All Leads", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        if (state.leads.isNotEmpty()) {
                            Text("${state.leads.size} leads", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.leads.isNotEmpty(),
            onRefresh    = viewModel::refresh,
            modifier     = Modifier.fillMaxSize().padding(padding),
        ) {
            when {
                state.isLoading && state.leads.isEmpty() ->
                    ShimmerList(itemCount = 8, modifier = Modifier.fillMaxSize())
                state.error != null && state.leads.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = viewModel::refresh, modifier = Modifier.fillMaxSize())
                else -> LazyColumn(
                    state               = listState,
                    contentPadding      = PaddingValues(bottom = Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    modifier            = Modifier.fillMaxSize(),
                ) {
                    item {
                        OutlinedTextField(
                            value         = state.search,
                            onValueChange = viewModel::setSearch,
                            placeholder   = { Text("Search leads…") },
                            singleLine    = true,
                            modifier      = Modifier.fillMaxWidth().padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingMd),
                        )
                    }
                    item {
                        LazyRow(
                            horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                            contentPadding        = PaddingValues(horizontal = Dimens.SpacingLg),
                        ) {
                            items(STATUS_FILTERS) { status ->
                                FilterChip(
                                    selected = state.selectedStatus == status,
                                    onClick  = { viewModel.setStatus(status) },
                                    label    = { Text(status ?: "All") },
                                )
                            }
                        }
                    }
                    if (state.leads.isEmpty() && !state.isLoading) {
                        item { EmptyState(message = "No leads found.", icon = Icons.Default.People, modifier = Modifier.fillMaxWidth().padding(32.dp)) }
                    } else {
                        items(state.leads, key = { it.id }) { item ->
                            LeadCard(item, onClick = { onLeadClick(item.id) }, modifier = Modifier.padding(horizontal = Dimens.SpacingLg))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun LeadCard(item: LeadItem, onClick: () -> Unit, modifier: Modifier = Modifier) {
    WellnessCard(modifier = modifier.fillMaxWidth(), onClick = onClick) {
        Row(
            modifier              = Modifier.fillMaxWidth().padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(item.name ?: "Unknown", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                if (!item.email.isNullOrBlank()) {
                    Text(item.email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!item.phone.isNullOrBlank()) {
                    Text(item.phone, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!item.company.isNullOrBlank()) {
                    Text(item.company, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                if (!item.status.isNullOrBlank()) {
                    Text(
                        text       = item.status,
                        style      = MaterialTheme.typography.labelSmall,
                        color      = WellnessPrimary,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                if (item.score != null) {
                    Text("Score: ${item.score}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(item.createdAt.take(10), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

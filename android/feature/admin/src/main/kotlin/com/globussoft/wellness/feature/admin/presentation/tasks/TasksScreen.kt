package com.globussoft.wellness.feature.admin.presentation.tasks

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
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
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
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.feature.admin.domain.repository.TaskItem

private val STATUS_FILTERS = listOf(null to "All", "pending" to "Pending", "in_progress" to "In Progress", "done" to "Done")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(
    viewModel: TasksViewModel = hiltViewModel(),
) {
    val state     by viewModel.state.collectAsStateWithLifecycle()
    val listState  = rememberLazyListState()

    val shouldLoadMore by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= state.tasks.size - 4 && !state.isLoading && state.currentPage < state.totalPages
        }
    }
    LaunchedEffect(shouldLoadMore) { if (shouldLoadMore) viewModel.loadNextPage() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Tasks", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        if (state.tasks.isNotEmpty()) {
                            Text("${state.tasks.size} tasks", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.tasks.isNotEmpty(),
            onRefresh    = viewModel::refresh,
            modifier     = Modifier.fillMaxSize().padding(padding),
        ) {
            when {
                state.isLoading && state.tasks.isEmpty() ->
                    ShimmerList(itemCount = 8, modifier = Modifier.fillMaxSize())
                state.error != null && state.tasks.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = viewModel::refresh, modifier = Modifier.fillMaxSize())
                else -> LazyColumn(
                    state               = listState,
                    contentPadding      = PaddingValues(bottom = Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    modifier            = Modifier.fillMaxSize(),
                ) {
                    item {
                        LazyRow(
                            horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                            contentPadding        = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingMd),
                        ) {
                            items(STATUS_FILTERS) { (value, label) ->
                                FilterChip(
                                    selected = state.selectedStatus == value,
                                    onClick  = { viewModel.setStatus(value) },
                                    label    = { Text(label) },
                                )
                            }
                        }
                    }
                    if (state.tasks.isEmpty() && !state.isLoading) {
                        item { EmptyState(message = "No tasks found.", icon = Icons.Default.CheckCircle, modifier = Modifier.fillMaxWidth()) }
                    } else {
                        items(state.tasks, key = { it.id }) { item ->
                            TaskCard(item, modifier = Modifier.padding(horizontal = Dimens.SpacingLg))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskCard(item: TaskItem, modifier: Modifier = Modifier) {
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier              = Modifier.fillMaxWidth().padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.Top,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(item.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                if (!item.description.isNullOrBlank()) {
                    Text(item.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
                }
                if (!item.assignedToName.isNullOrBlank()) {
                    Text("Assigned: ${item.assignedToName}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!item.dueDate.isNullOrBlank()) {
                    Text("Due: ${item.dueDate.take(10)}", style = MaterialTheme.typography.bodySmall, color = WellnessDanger)
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                val statusColor = when (item.status.lowercase()) {
                    "done"        -> WellnessPrimary
                    "in_progress" -> MaterialTheme.colorScheme.tertiary
                    else          -> MaterialTheme.colorScheme.onSurfaceVariant
                }
                Text(
                    text       = item.status.replace('_', ' ').replaceFirstChar { it.uppercase() },
                    style      = MaterialTheme.typography.labelSmall,
                    color      = statusColor,
                    fontWeight = FontWeight.SemiBold,
                )
                if (!item.priority.isNullOrBlank()) {
                    Text(item.priority, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

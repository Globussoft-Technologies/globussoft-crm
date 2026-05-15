package com.globussoft.wellness.feature.crm.presentation.auditlog

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AuditLogScreen(
    viewModel: AuditLogViewModel = hiltViewModel(),
) {
    val state     by viewModel.state.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()

    // Trigger next-page load when near the bottom
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo }
            .collect { layoutInfo ->
                val totalItems   = layoutInfo.totalItemsCount
                val lastVisible  = layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
                if (totalItems > 0 && lastVisible >= totalItems - 3) {
                    viewModel.loadNextPage()
                }
            }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Audit Log") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
    ) { paddingValues ->
        PullToRefreshBox(
            isRefreshing = state.isLoading,
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                // Entity type filter chips
                val entityTypes = listOf("All" to null, "Contact" to "Contact", "Deal" to "Deal", "Ticket" to "Ticket", "User" to "User", "Invoice" to "Invoice")
                LazyRow(
                    modifier              = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(entityTypes) { item ->
                        FilterChip(
                            selected = state.selectedEntityType == item.second,
                            onClick  = { viewModel.setEntityType(item.second) },
                            label    = { Text(item.first, style = MaterialTheme.typography.bodySmall) },
                            colors   = FilterChipDefaults.filterChipColors(selectedContainerColor = GenericPrimary, selectedLabelColor = Color.White),
                        )
                    }
                }

                // Action filter chips
                val actions = listOf("All" to null, "CREATE" to "CREATE", "UPDATE" to "UPDATE", "DELETE" to "DELETE")
                LazyRow(
                    modifier              = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(actions) { item ->
                        FilterChip(
                            selected = state.selectedAction == item.second,
                            onClick  = { viewModel.setAction(item.second) },
                            label    = { Text(item.first, style = MaterialTheme.typography.bodySmall) },
                            colors   = FilterChipDefaults.filterChipColors(selectedContainerColor = GenericPrimary, selectedLabelColor = Color.White),
                        )
                    }
                }

            when {
                state.isLoading && state.logs.isEmpty() -> {
                    ShimmerList(
                        itemCount = 7,
                        modifier  = Modifier.padding(Dimens.SpacingLg),
                    )
                }
                state.error != null && state.logs.isEmpty() -> {
                    ErrorState(
                        message  = state.error!!,
                        onRetry  = { viewModel.refresh() },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                state.logs.isEmpty() -> {
                    EmptyState(
                        message  = "No audit log entries found",
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                else -> {
                    LazyColumn(
                        state               = listState,
                        modifier            = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                        contentPadding      = PaddingValues(
                            horizontal = Dimens.SpacingLg,
                            vertical   = Dimens.SpacingSm,
                        ),
                    ) {
                        itemsIndexed(state.logs) { _, log ->
                            AuditLogCard(log = log)
                        }
                        if (state.currentPage < state.totalPages) {
                            item {
                                Button(
                                    onClick  = { viewModel.loadNextPage() },
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = Dimens.SpacingSm),
                                    colors   = ButtonDefaults.buttonColors(
                                        containerColor = GenericPrimary,
                                    ),
                                ) {
                                    Text("Load More")
                                }
                            }
                        }
                    }
                }
            }
            } // end Column
        }
    }
}

@Composable
private fun AuditLogCard(
    log:      Map<String, Any>,
    modifier: Modifier = Modifier,
) {
    val action    = log["action"]?.toString() ?: "Unknown"
    val entity    = log["entity"]?.toString() ?: ""
    val entityId  = log["entityId"]?.toString() ?: ""
    val userName  = log["userName"]?.toString() ?: ""
    val timestamp = log["timestamp"]?.toString() ?: ""

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
        ) {
            Row(
                modifier          = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text     = action,
                    style    = MaterialTheme.typography.titleSmall,
                    color    = GenericPrimary,
                    modifier = Modifier.weight(1f),
                )
                if (timestamp.isNotBlank()) {
                    Text(
                        text  = timestamp,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            if (entity.isNotBlank() || entityId.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text  = buildString {
                        if (entity.isNotBlank()) append(entity)
                        if (entity.isNotBlank() && entityId.isNotBlank()) append(" #")
                        if (entityId.isNotBlank()) append(entityId)
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (userName.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(
                    text  = "by $userName",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

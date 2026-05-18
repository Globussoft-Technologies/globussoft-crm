package com.globussoft.wellness.feature.crm.presentation.doctracking

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.graphics.Color
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
fun DocTrackingScreen(
    viewModel: DocTrackingViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Document Tracking") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.views.isNotEmpty(),
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            when {
                state.isLoading && state.views.isEmpty() -> ShimmerList(
                    itemCount = 5,
                    modifier  = Modifier.fillMaxSize(),
                )
                state.error != null && state.views.isEmpty() -> ErrorState(
                    message  = state.error!!,
                    onRetry  = { viewModel.refresh() },
                    modifier = Modifier.fillMaxSize(),
                )
                state.views.isEmpty() -> EmptyState(
                    message  = "No document views yet.",
                    modifier = Modifier.fillMaxSize(),
                )
                else -> LazyColumn(
                    contentPadding      = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                ) {
                    items(state.views, key = { it["id"]?.toString() ?: it.hashCode().toString() }) { view ->
                        DocViewCard(view = view)
                    }
                }
            }
        }
    }
}

@Composable
private fun DocViewCard(
    view: Map<String, Any>,
    modifier: Modifier = Modifier,
) {
    val docName    = view["documentName"] as? String
        ?: (view["documentTemplate"] as? Map<*, *>)?.get("name") as? String
        ?: view["name"] as? String
        ?: "Untitled Document"
    val viewCount  = (view["viewCount"] as? Number)?.toInt() ?: 0
    val lastViewed = view["lastViewedAt"] as? String ?: view["viewedAt"] as? String ?: ""
    val opened     = (view["opened"] as? Boolean) ?: (viewCount > 0)

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(text = docName, style = MaterialTheme.typography.titleSmall)
                if (lastViewed.isNotBlank()) {
                    Text(
                        text  = "Last viewed: ${lastViewed.take(10)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    text  = "$viewCount view${if (viewCount == 1) "" else "s"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            SuggestionChip(
                onClick = {},
                label   = {
                    Text(
                        text  = if (opened) "Opened" else "Not opened",
                        style = MaterialTheme.typography.labelSmall,
                        color = Color.White,
                    )
                },
                colors = SuggestionChipDefaults.suggestionChipColors(
                    containerColor = if (opened) GenericPrimary else MaterialTheme.colorScheme.outline,
                ),
                border = null,
            )
        }
    }
}

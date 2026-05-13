package com.globussoft.wellness.feature.dashboard.presentation.recommendations

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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
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
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.ConfirmDialog
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.PriorityBadge
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessDangerButton
import com.globussoft.wellness.core.designsystem.components.WellnessOutlinedButton
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessSuccess
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.globussoft.wellness.core.domain.model.Recommendation
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// ─── Screen entry-point ───────────────────────────────────────────────────────

/**
 * AI Recommendations screen.
 *
 * Shows a filter chip strip (Pending / Approved / Rejected / All) and a lazy
 * list of recommendation cards.  Approve/Reject actions flow through a confirm
 * dialog.  The "Run Now" AppBar button triggers the orchestrator with a confirm
 * guard.
 *
 * @param viewModel Hilt-injected [RecommendationsViewModel] (default).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecommendationsScreen(
    viewModel: RecommendationsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    // Show error inline when non-null — the lazy list stays visible underneath.
    LaunchedEffect(state.error) {
        state.error?.let { msg ->
            scope.launch { snackbarHostState.showSnackbar(msg) }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar       = {
            RecommendationsTopBar(
                onRunOrchestrator = {
                    viewModel.onEvent(RecommendationsEvent.RunOrchestratorRequested)
                },
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->

        PullToRefreshBox(
            isRefreshing = state.isLoading && state.recommendations.isNotEmpty(),
            onRefresh    = { viewModel.onEvent(RecommendationsEvent.Refresh) },
            modifier     = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                // Filter chip strip.
                FilterChipRow(
                    activeFilter  = state.activeFilter,
                    recommendations = state.recommendations,
                    onFilterSelect = { viewModel.onEvent(RecommendationsEvent.FilterChanged(it)) },
                )

                // Content area.
                Box(modifier = Modifier.weight(1f)) {
                    when {
                        state.isLoading && state.recommendations.isEmpty() -> {
                            ShimmerList(itemCount = 4, modifier = Modifier.fillMaxSize())
                        }
                        state.error != null && state.recommendations.isEmpty() -> {
                            ErrorState(
                                message  = state.error,
                                onRetry  = { viewModel.onEvent(RecommendationsEvent.Refresh) },
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                        state.recommendations.isEmpty() -> {
                            EmptyState(
                                message     = emptyMessage(state.activeFilter),
                                actionLabel = "Run AI Now",
                                onAction    = { viewModel.onEvent(RecommendationsEvent.RunOrchestratorRequested) },
                                modifier    = Modifier.fillMaxSize(),
                            )
                        }
                        else -> {
                            RecommendationsList(
                                recommendations = state.recommendations,
                                filter          = state.activeFilter,
                                onApprove       = { viewModel.onEvent(RecommendationsEvent.ApproveRequested(it)) },
                                onReject        = { viewModel.onEvent(RecommendationsEvent.RejectRequested(it)) },
                            )
                        }
                    }
                }
            }
        }
    }

    // Confirmation dialog — rendered on top of the scaffold.
    state.confirmingAction?.let { action ->
        ConfirmDialog(
            title          = action.title,
            message        = action.message,
            confirmLabel   = when (action.type) {
                ActionType.APPROVE          -> "Approve"
                ActionType.REJECT           -> "Reject"
                ActionType.RUN_ORCHESTRATOR -> "Run Now"
            },
            isDestructive  = action.type == ActionType.REJECT,
            onConfirm      = { viewModel.onEvent(RecommendationsEvent.ConfirmAction(action)) },
            onDismiss      = { viewModel.onEvent(RecommendationsEvent.DismissConfirm) },
        )
    }
}

// ─── TopAppBar ────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RecommendationsTopBar(onRunOrchestrator: () -> Unit) {
    TopAppBar(
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector        = Icons.Default.AutoAwesome,
                    contentDescription = null,
                    tint               = WellnessPrimary,
                    modifier           = Modifier.size(22.dp),
                )
                Spacer(modifier = Modifier.width(Dimens.SpacingSm))
                Text(
                    text  = "AI Recommendations",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        },
        actions = {
            TextButton(onClick = onRunOrchestrator) {
                Icon(
                    imageVector        = Icons.Default.PlayArrow,
                    contentDescription = null,
                    modifier           = Modifier.size(16.dp),
                )
                Spacer(modifier = Modifier.width(Dimens.SpacingXs))
                Text("Run Now")
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
    )
}

// ─── Filter chip row ──────────────────────────────────────────────────────────

@Composable
private fun FilterChipRow(
    activeFilter: String,
    recommendations: List<Recommendation>,
    onFilterSelect: (String) -> Unit,
) {
    // Count badges per filter — only approximate since we display the CURRENTLY
    // LOADED list; the exact count for other filters requires separate API calls.
    val pendingCount  = recommendations.count { it.status == "pending" }
    val approvedCount = recommendations.count { it.status == "approved" }
    val rejectedCount = recommendations.count { it.status == "rejected" }

    val filters = listOf(
        RecommendationsUiState.FILTER_PENDING  to (if (pendingCount  > 0) pendingCount.toString()  else null),
        RecommendationsUiState.FILTER_APPROVED to (if (approvedCount > 0) approvedCount.toString() else null),
        RecommendationsUiState.FILTER_REJECTED to (if (rejectedCount > 0) rejectedCount.toString() else null),
        RecommendationsUiState.FILTER_ALL      to null,
    )

    LazyRow(
        contentPadding        = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
    ) {
        items(filters) { (filter, badge) ->
            val selected = filter == activeFilter
            BadgedBox(
                badge = {
                    if (badge != null && !selected) {
                        Badge { Text(badge, style = MaterialTheme.typography.labelSmall) }
                    }
                },
            ) {
                FilterChip(
                    selected = selected,
                    onClick  = { onFilterSelect(filter) },
                    label    = { Text(filter.replaceFirstChar { it.uppercase() }) },
                    colors   = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = WellnessPrimary,
                        selectedLabelColor     = androidx.compose.ui.graphics.Color.White,
                    ),
                )
            }
        }
    }
}

// ─── Recommendations list ─────────────────────────────────────────────────────

@Composable
private fun RecommendationsList(
    recommendations: List<Recommendation>,
    filter: String,
    onApprove: (String) -> Unit,
    onReject: (String) -> Unit,
) {
    LazyColumn(
        contentPadding      = PaddingValues(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
    ) {
        items(recommendations, key = { it.id }) { rec ->
            RecommendationCard(
                recommendation = rec,
                showActions    = rec.status == "pending" || filter == "pending",
                onApprove      = onApprove,
                onReject       = onReject,
            )
        }
    }
}

// ─── Single recommendation card ───────────────────────────────────────────────

@Composable
private fun RecommendationCard(
    recommendation: Recommendation,
    showActions: Boolean,
    onApprove: (String) -> Unit,
    onReject: (String) -> Unit,
) {
    WellnessCard {
        Column(
            modifier = Modifier.padding(Dimens.SpacingLg),
        ) {
            // Header: priority badge + type label.
            Row(
                verticalAlignment     = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier              = Modifier.fillMaxWidth(),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    PriorityBadge(priority = recommendation.priority.uppercase())
                    Spacer(modifier = Modifier.width(Dimens.SpacingSm))
                    Text(
                        text  = recommendation.type.replaceFirstChar { it.uppercase() },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                // Status indicator for non-pending cards.
                if (recommendation.status != "pending") {
                    Text(
                        text  = recommendation.status.replaceFirstChar { it.uppercase() },
                        style = MaterialTheme.typography.labelSmall,
                        color = when (recommendation.status) {
                            "approved" -> WellnessSuccess
                            "rejected" -> WellnessDanger
                            else       -> MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }

            Spacer(modifier = Modifier.height(Dimens.SpacingSm))

            // Title.
            Text(
                text       = recommendation.title,
                style      = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
            )

            Spacer(modifier = Modifier.height(Dimens.SpacingXs))

            // Body text.
            Text(
                text  = recommendation.body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            // Expected impact — shown when present.
            if (!recommendation.expectedImpact.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(Dimens.SpacingSm))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector        = Icons.Default.AutoAwesome,
                        contentDescription = null,
                        tint               = WellnessPrimary,
                        modifier           = Modifier.size(14.dp),
                    )
                    Spacer(modifier = Modifier.width(Dimens.SpacingXs))
                    Text(
                        text  = recommendation.expectedImpact,
                        style = MaterialTheme.typography.labelSmall,
                        color = WellnessPrimary,
                    )
                }
            }

            Spacer(modifier = Modifier.height(Dimens.SpacingMd))

            // Footer: date + action buttons (pending only).
            Row(
                verticalAlignment     = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier              = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text  = formatIsoDate(recommendation.createdAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                if (showActions && recommendation.status == "pending") {
                    Row(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm)) {
                        WellnessDangerButton(
                            text    = "Reject",
                            onClick = { onReject(recommendation.id) },
                        )
                        WellnessOutlinedButton(
                            text    = "Approve",
                            onClick = { onApprove(recommendation.id) },
                        )
                    }
                }
            }
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

private fun emptyMessage(filter: String): String = when (filter) {
    RecommendationsUiState.FILTER_PENDING  ->
        "No pending recommendations. Tap \"Run Now\" to generate fresh AI insights."
    RecommendationsUiState.FILTER_APPROVED -> "No approved recommendations yet."
    RecommendationsUiState.FILTER_REJECTED -> "No rejected recommendations."
    else                                   -> "No recommendations found."
}

private val DATE_FMT = DateTimeFormatter.ofPattern("d MMM yyyy", Locale.getDefault())

private fun formatIsoDate(iso: String): String {
    return runCatching {
        val instant = Instant.parse(iso)
        DATE_FMT.format(instant.atZone(ZoneId.systemDefault()))
    }.getOrDefault(iso)
}

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "RecommendationCard – pending", showBackground = true)
@Composable
private fun RecommendationCardPreview() {
    WellnessTheme {
        RecommendationCard(
            recommendation = Recommendation(
                id             = "1",
                title          = "Increase follow-up SMS for high-value patients",
                body           = "3 patients with >₹20,000 lifetime value have not visited in 60+ days. A personalised re-engagement SMS could recover ₹8,000–₹12,000 in revenue.",
                priority       = "high",
                type           = "retention",
                status         = "pending",
                expectedImpact = "Est. ₹10,000 revenue recovery within 30 days",
                createdAt      = "2026-05-13T07:00:00.000Z",
                resolvedAt     = null,
            ),
            showActions = true,
            onApprove   = {},
            onReject    = {},
        )
    }
}

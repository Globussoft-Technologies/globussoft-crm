package com.globussoft.wellness.feature.crm.presentation.dealinsights

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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.domain.model.DealInsight

private val RISK_FILTERS = listOf(
    null     to "All",
    "LOW"    to "Low",
    "MEDIUM" to "Medium",
    "HIGH"   to "High",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DealInsightsScreen(
    viewModel: DealInsightsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Deal Insights")
                        if (state.insights.isNotEmpty()) {
                            Text(
                                text = "${state.insights.size} insight${if (state.insights.size != 1) "s" else ""}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
    ) { innerPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.insights.isNotEmpty(),
            onRefresh = viewModel::refresh,
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                // Risk filter chips
                LazyRow(
                    contentPadding = PaddingValues(horizontal = Dimens.SpacingLg),
                    horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = Dimens.SpacingSm),
                ) {
                    items(RISK_FILTERS, key = { it.first ?: "all" }) { (risk, label) ->
                        FilterChip(
                            selected = state.selectedRisk == risk,
                            onClick = { viewModel.setRisk(risk) },
                            label = { Text(label) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = riskColor(risk).copy(alpha = 0.15f),
                                selectedLabelColor = riskColor(risk),
                            ),
                        )
                    }
                }

                when {
                    state.isLoading && state.insights.isEmpty() -> {
                        ShimmerList(modifier = Modifier.fillMaxSize())
                    }
                    state.error != null && state.insights.isEmpty() -> {
                        ErrorState(
                            message = state.error ?: "Failed to load deal insights",
                            onRetry = viewModel::refresh,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    state.insights.isEmpty() -> {
                        EmptyState(
                            message = if (state.selectedRisk != null)
                                "No ${state.selectedRisk?.lowercase()} risk insights"
                            else
                                "No deal insights available",
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    else -> {
                        LazyColumn(
                            contentPadding = PaddingValues(
                                start = Dimens.SpacingLg,
                                end = Dimens.SpacingLg,
                                bottom = Dimens.SpacingLg,
                            ),
                            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                            modifier = Modifier.fillMaxSize(),
                        ) {
                            items(state.insights, key = { it.id }) { insight ->
                                DealInsightCard(insight = insight)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DealInsightCard(
    insight: DealInsight,
    modifier: Modifier = Modifier,
) {
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
            // Header: deal title + closability score
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = insight.dealTitle ?: "Untitled Deal",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val score = insight.closabilityScore
                SuggestionChip(
                    onClick = {},
                    label = {
                        Text(
                            text = "${score ?: "?"}/100",
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                        )
                    },
                    colors = SuggestionChipDefaults.suggestionChipColors(
                        containerColor = closabilityColor(score).copy(alpha = 0.14f),
                        labelColor = closabilityColor(score),
                    ),
                )
            }

            Spacer(Modifier.height(Dimens.SpacingXs))

            // Risk level chip
            insight.riskLevel?.let { risk ->
                SuggestionChip(
                    onClick = {},
                    label = {
                        Text(
                            text = risk,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    },
                    colors = SuggestionChipDefaults.suggestionChipColors(
                        containerColor = riskColor(risk).copy(alpha = 0.14f),
                        labelColor = riskColor(risk),
                    ),
                )
                Spacer(Modifier.height(Dimens.SpacingXs))
            }

            // Suggested action
            insight.suggestedAction?.takeIf { it.isNotBlank() }?.let { action ->
                Text(
                    text = action,
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Medium,
                    color = GenericPrimary,
                )
                Spacer(Modifier.height(Dimens.SpacingXs))
            }

            // AI insights summary
            insight.insights?.takeIf { it.isNotBlank() }?.let { summary ->
                Text(
                    text = summary,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

private fun closabilityColor(score: Int?): Color = when {
    score == null  -> Color(0xFF6B7280) // grey
    score >= 70    -> Color(0xFF10B981) // green
    score >= 40    -> Color(0xFFF59E0B) // yellow/amber
    else           -> Color(0xFFEF4444) // red
}

private fun riskColor(risk: String?): Color = when (risk) {
    "HIGH"   -> Color(0xFFEF4444)  // red
    "MEDIUM" -> Color(0xFFF97316)  // orange
    "LOW"    -> Color(0xFF10B981)  // green
    else     -> GenericAccent
}

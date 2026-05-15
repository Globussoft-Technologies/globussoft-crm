package com.globussoft.wellness.feature.crm.presentation.forecasting

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
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.domain.model.ForecastEntry

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ForecastingScreen(
    viewModel: ForecastingViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Revenue Forecasting") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
    ) { innerPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.entries.isNotEmpty(),
            onRefresh = viewModel::refresh,
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            when {
                state.isLoading && state.entries.isEmpty() -> {
                    ShimmerList(modifier = Modifier.fillMaxSize())
                }
                state.error != null && state.entries.isEmpty() -> {
                    ErrorState(
                        message = state.error ?: "Failed to load forecasting data",
                        onRetry = viewModel::refresh,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                state.entries.isEmpty() -> {
                    EmptyState(
                        message = "No forecast data available",
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                else -> {
                    val totalWeighted = state.entries.sumOf { it.weightedValue }
                    val totalPipeline = state.entries.sumOf { it.totalValue }

                    LazyColumn(
                        contentPadding = PaddingValues(Dimens.SpacingLg),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        // Summary row
                        item {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                            ) {
                                SummaryCard(
                                    label = "Weighted Value",
                                    value = "$%.0f".format(totalWeighted),
                                    valueColor = GenericAccent,
                                    modifier = Modifier.weight(1f),
                                )
                                SummaryCard(
                                    label = "Pipeline Value",
                                    value = "$%.0f".format(totalPipeline),
                                    valueColor = GenericPrimary,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        }

                        item {
                            Spacer(Modifier.height(Dimens.SpacingXs))
                        }

                        // Per-stage cards
                        items(state.entries, key = { it.stage }) { entry ->
                            ForecastEntryCard(entry = entry)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SummaryCard(
    label: String,
    value: String,
    valueColor: Color,
    modifier: Modifier = Modifier,
) {
    WellnessCard(modifier = modifier) {
        Column(
            modifier = Modifier.padding(Dimens.SpacingMd),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = value,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = valueColor,
            )
        }
    }
}

@Composable
private fun ForecastEntryCard(
    entry: ForecastEntry,
    modifier: Modifier = Modifier,
) {
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = entry.stage,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                SuggestionChip(
                    onClick = {},
                    label = {
                        Text(
                            text = "${entry.probability}%",
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                    },
                    colors = SuggestionChipDefaults.suggestionChipColors(
                        containerColor = GenericPrimary.copy(alpha = 0.10f),
                        labelColor = GenericPrimary,
                    ),
                )
            }

            Spacer(Modifier.height(Dimens.SpacingXs))

            Text(
                text = "${entry.dealCount} deal${if (entry.dealCount != 1) "s" else ""}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(Dimens.SpacingXs))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column {
                    Text(
                        text = "Total Value",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = "$%.0f".format(entry.totalValue),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text = "Weighted Value",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = "$%.0f".format(entry.weightedValue),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        color = GenericAccent,
                    )
                }
            }

            Spacer(Modifier.height(Dimens.SpacingSm))

            LinearProgressIndicator(
                progress = { (entry.probability / 100f).coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth(),
                color = GenericAccent,
                trackColor = GenericAccent.copy(alpha = 0.15f),
            )
        }
    }
}

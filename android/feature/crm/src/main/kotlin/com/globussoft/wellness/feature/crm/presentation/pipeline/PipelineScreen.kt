package com.globussoft.wellness.feature.crm.presentation.pipeline

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
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
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.domain.model.Deal
import com.globussoft.wellness.core.domain.model.Pipeline

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PipelineScreen(
    viewModel: PipelineViewModel = hiltViewModel(),
    onDealClick: (String) -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "Pipeline",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.pipelines.isNotEmpty(),
            onRefresh    = viewModel::refresh,
            modifier     = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when {
                state.isLoading && state.pipelines.isEmpty() ->
                    ShimmerList(itemCount = 6, modifier = Modifier.fillMaxSize())

                state.error != null && state.pipelines.isEmpty() ->
                    ErrorState(
                        message  = state.error!!,
                        onRetry  = viewModel::refresh,
                        modifier = Modifier.fillMaxSize(),
                    )

                else -> {
                    val selectedPipeline = state.pipelines.find { it.id == state.selectedPipelineId }

                    LazyColumn(
                        contentPadding      = PaddingValues(bottom = Dimens.SpacingLg),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                        modifier            = Modifier.fillMaxSize(),
                    ) {
                        // Pipeline selector chips (only when multiple pipelines)
                        if (state.pipelines.size > 1) {
                            item(key = "pipeline-chips") {
                                LazyRow(
                                    horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                                    contentPadding        = PaddingValues(
                                        horizontal = Dimens.SpacingLg,
                                        vertical   = Dimens.SpacingMd,
                                    ),
                                ) {
                                    items(state.pipelines, key = { it.id }) { pipeline ->
                                        FilterChip(
                                            selected = state.selectedPipelineId == pipeline.id,
                                            onClick  = {
                                                // selecting a pipeline clears stage and reloads
                                                viewModel.selectStage(null)
                                            },
                                            label    = { Text(pipeline.name) },
                                            colors   = FilterChipDefaults.filterChipColors(
                                                selectedContainerColor = GenericPrimary.copy(alpha = 0.15f),
                                                selectedLabelColor     = GenericPrimary,
                                            ),
                                        )
                                    }
                                }
                            }
                        }

                        // Stage cards
                        if (selectedPipeline != null) {
                            items(
                                items = selectedPipeline.stages.sortedBy { it.order },
                                key   = { it.id },
                            ) { stage ->
                                val isSelected = state.selectedStage == stage.name
                                val stageDeals = state.deals.filter { it.stage == stage.name }
                                val stageValue = stageDeals.sumOf { it.amount }

                                WellnessCard(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = Dimens.SpacingLg),
                                    onClick  = {
                                        viewModel.selectStage(
                                            if (isSelected) null else stage.name,
                                        )
                                    },
                                ) {
                                    Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
                                        Row(
                                            modifier              = Modifier.fillMaxWidth(),
                                            horizontalArrangement = Arrangement.SpaceBetween,
                                            verticalAlignment     = Alignment.CenterVertically,
                                        ) {
                                            Column(modifier = Modifier.weight(1f)) {
                                                Text(
                                                    text       = stage.name,
                                                    style      = MaterialTheme.typography.titleSmall,
                                                    fontWeight = FontWeight.SemiBold,
                                                    color      = if (isSelected) GenericPrimary
                                                                 else MaterialTheme.colorScheme.onSurface,
                                                )
                                                Text(
                                                    text  = "${stage.dealCount} deal${if (stage.dealCount != 1) "s" else ""}",
                                                    style = MaterialTheme.typography.bodySmall,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                )
                                            }
                                            if (stageValue > 0) {
                                                Text(
                                                    text       = "${"%.0f".format(stageValue)}",
                                                    style      = MaterialTheme.typography.titleSmall,
                                                    fontWeight = FontWeight.Bold,
                                                    color      = GenericAccent,
                                                )
                                            }
                                        }

                                        // Expanded deals list
                                        if (isSelected) {
                                            Spacer(Modifier.height(8.dp))
                                            HorizontalDivider()
                                            Spacer(Modifier.height(8.dp))

                                            if (state.dealsLoading) {
                                                ShimmerList(itemCount = 3)
                                            } else if (stageDeals.isEmpty()) {
                                                EmptyState(
                                                    message = "No deals in ${stage.name}",
                                                    modifier = Modifier.fillMaxWidth(),
                                                )
                                            } else {
                                                stageDeals.forEach { deal ->
                                                    DealRow(
                                                        deal    = deal,
                                                        onClick = { onDealClick(deal.id) },
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } else if (state.pipelines.isEmpty() && !state.isLoading) {
                            item {
                                EmptyState(
                                    message = "No pipelines found.",
                                    icon    = Icons.Outlined.AccountTree,
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DealRow(
    deal: Deal,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    WellnessCard(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        onClick  = onClick,
    ) {
        Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text       = deal.title,
                    style      = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier   = Modifier.weight(1f),
                )
                Text(
                    text       = "${"%.0f".format(deal.amount)}",
                    style      = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Bold,
                    color      = GenericAccent,
                )
            }
            deal.contactName?.takeIf { it.isNotBlank() }?.let { name ->
                Text(
                    text  = name,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            deal.expectedClose?.takeIf { it.isNotBlank() }?.let { close ->
                Text(
                    text  = "Close: ${close.take(10)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

package com.globussoft.wellness.feature.finance.presentation.estimates

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
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
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.feature.finance.domain.model.EstimateItem

private val STATUS_FILTERS = listOf(null to "All", "DRAFT" to "Draft", "SENT" to "Sent", "ACCEPTED" to "Accepted", "REJECTED" to "Rejected")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EstimatesScreen(
    viewModel: EstimatesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Estimates", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        if (state.estimates.isNotEmpty()) {
                            Text("${state.estimates.size} estimates", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.estimates.isNotEmpty(),
            onRefresh    = viewModel::refresh,
            modifier     = Modifier.fillMaxSize().padding(padding),
        ) {
            when {
                state.isLoading && state.estimates.isEmpty() ->
                    ShimmerList(itemCount = 6, modifier = Modifier.fillMaxSize())
                state.error != null && state.estimates.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = viewModel::refresh, modifier = Modifier.fillMaxSize())
                else -> LazyColumn(
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
                    if (state.estimates.isEmpty() && !state.isLoading) {
                        item { EmptyState(message = "No estimates found.", icon = Icons.Default.Description, modifier = Modifier.fillMaxWidth()) }
                    } else {
                        items(state.estimates, key = { it.id }) { item ->
                            EstimateCard(item, modifier = Modifier.padding(horizontal = Dimens.SpacingLg))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EstimateCard(item: EstimateItem, modifier: Modifier = Modifier) {
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier              = Modifier.fillMaxWidth().padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text  = item.title ?: item.estimateNum ?: "Estimate",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                if (!item.estimateNum.isNullOrBlank() && !item.title.isNullOrBlank()) {
                    Text(item.estimateNum, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!item.contactName.isNullOrBlank()) {
                    Text(item.contactName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!item.validUntil.isNullOrBlank()) {
                    Text("Valid until: ${item.validUntil.take(10)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text       = "₹${"%.0f".format(item.totalAmount)}",
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color      = WellnessPrimary,
                )
                Text(
                    text  = item.status,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

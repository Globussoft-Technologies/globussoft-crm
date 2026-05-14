package com.globussoft.wellness.feature.finance.presentation.invoices

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
import androidx.compose.material.icons.filled.Receipt
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
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.feature.finance.domain.model.InvoiceItem

private val STATUS_FILTERS = listOf(null to "All", "DRAFT" to "Draft", "SENT" to "Sent", "PAID" to "Paid", "OVERDUE" to "Overdue")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InvoicesScreen(
    viewModel: InvoicesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Invoices", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        if (state.invoices.isNotEmpty()) {
                            Text("${state.invoices.size} invoices", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.invoices.isNotEmpty(),
            onRefresh    = viewModel::refresh,
            modifier     = Modifier.fillMaxSize().padding(padding),
        ) {
            when {
                state.isLoading && state.invoices.isEmpty() ->
                    ShimmerList(itemCount = 8, modifier = Modifier.fillMaxSize())
                state.error != null && state.invoices.isEmpty() ->
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
                    if (state.invoices.isEmpty() && !state.isLoading) {
                        item { EmptyState(message = "No invoices found.", icon = Icons.Default.Receipt, modifier = Modifier.fillMaxWidth()) }
                    } else {
                        items(state.invoices, key = { it.id }) { item ->
                            InvoiceCard(item, modifier = Modifier.padding(horizontal = Dimens.SpacingLg))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun InvoiceCard(item: InvoiceItem, modifier: Modifier = Modifier) {
    val statusColor = when (item.status) {
        "PAID"    -> WellnessPrimary
        "OVERDUE" -> WellnessDanger
        else      -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier              = Modifier.fillMaxWidth().padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(item.invoiceNum ?: item.id.takeLast(8), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                if (!item.contactName.isNullOrBlank()) {
                    Text(item.contactName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!item.dueDate.isNullOrBlank()) {
                    Text("Due: ${item.dueDate.take(10)}", style = MaterialTheme.typography.bodySmall, color = if (item.status == "OVERDUE") WellnessDanger else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (item.isRecurring) {
                    Text("Recurring", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text       = "₹${"%.0f".format(item.amount)}",
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color      = WellnessPrimary,
                )
                Text(
                    text  = item.status,
                    style = MaterialTheme.typography.labelSmall,
                    color = statusColor,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

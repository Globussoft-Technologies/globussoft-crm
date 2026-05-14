package com.globussoft.wellness.feature.finance.presentation.payments

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
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Payment
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.feature.finance.domain.model.PaymentItem

private val GATEWAYS = listOf("All", "stripe", "razorpay", "cash")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PaymentsScreen(
    viewModel: PaymentsViewModel = hiltViewModel(),
    onNavigateBack: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    val displayed = if (state.gatewayFilter == null || state.gatewayFilter == "All") {
        state.payments
    } else {
        state.payments.filter { it.gateway.equals(state.gatewayFilter, ignoreCase = true) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Payments", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        if (state.payments.isNotEmpty()) {
                            Text("${displayed.size} of ${state.payments.size}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        Column(Modifier.fillMaxSize().padding(contentPadding)) {
            LazyRow(
                contentPadding      = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingXs),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
            ) {
                items(GATEWAYS) { gw ->
                    val selected = state.gatewayFilter.let { if (it == null) gw == "All" else it == gw }
                    FilterChip(
                        selected = selected,
                        onClick  = { viewModel.setGatewayFilter(if (gw == "All") null else gw) },
                        label    = { Text(gw.replaceFirstChar { it.uppercase() }) },
                    )
                }
            }

            PullToRefreshBox(
                isRefreshing = state.isLoading && state.payments.isNotEmpty(),
                onRefresh    = viewModel::refresh,
                modifier     = Modifier.fillMaxSize(),
            ) {
                when {
                    state.isLoading && state.payments.isEmpty() ->
                        ShimmerList(itemCount = 6, modifier = Modifier.fillMaxSize())
                    state.error != null && state.payments.isEmpty() ->
                        ErrorState(message = state.error!!, onRetry = viewModel::refresh, modifier = Modifier.fillMaxSize())
                    displayed.isEmpty() ->
                        EmptyState(message = "No payments found.", icon = Icons.Default.Payment, modifier = Modifier.fillMaxSize())
                    else -> LazyColumn(
                        contentPadding      = PaddingValues(Dimens.SpacingLg),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                        modifier            = Modifier.fillMaxSize(),
                    ) {
                        items(displayed, key = { it.id }) { item ->
                            PaymentCard(item)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PaymentCard(item: PaymentItem) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier              = Modifier.fillMaxWidth().padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs)) {
                    Text(
                        text       = item.gateway.replaceFirstChar { it.uppercase() },
                        style      = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    StatusPill(item.status)
                }
                Spacer(Modifier.height(2.dp))
                if (!item.invoiceId.isNullOrBlank()) {
                    Text("Invoice #${item.invoiceId}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                val date = (item.paidAt ?: item.createdAt).take(10)
                if (date.isNotBlank()) {
                    Text(date, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Text(
                text       = "${item.currency} ${"%,.2f".format(item.amount)}",
                style      = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color      = if (item.status.equals("FAILED", ignoreCase = true)) WellnessDanger else WellnessPrimary,
            )
        }
    }
}

@Composable
private fun StatusPill(status: String) {
    val color = when (status.uppercase()) {
        "PAID"     -> WellnessPrimary
        "FAILED"   -> WellnessDanger
        "REFUNDED" -> MaterialTheme.colorScheme.tertiary
        else       -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Text(
        text  = status,
        style = MaterialTheme.typography.labelSmall,
        color = color,
        fontWeight = FontWeight.SemiBold,
    )
}

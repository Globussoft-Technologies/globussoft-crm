package com.globus.crm.feature.finance.presentation.screen

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.globus.crm.core.ui.EmptyState
import com.globus.crm.core.ui.ErrorState
import com.globus.crm.core.ui.StatusChip
import com.globus.crm.core.ui.WellnessCard
import com.globus.crm.core.util.CurrencyUtil
import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.finance.domain.model.Payment
import com.globus.crm.feature.finance.presentation.state.FinanceUiEvent
import com.globus.crm.feature.finance.presentation.state.FinanceUiState
import com.globus.crm.feature.wallet.presentation.screen.GiftCardsScreen
import com.globus.crm.feature.wallet.presentation.screen.WalletScreen
import com.globus.crm.feature.wallet.presentation.state.GiftCardsUiEvent
import com.globus.crm.feature.wallet.presentation.state.GiftCardsUiState
import com.globus.crm.feature.wallet.presentation.state.WalletUiEvent
import com.globus.crm.feature.wallet.presentation.state.WalletUiState

private val TAB_LABELS = listOf("Payments", "Gift Cards", "Transactions")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FinanceTabScreen(
    paymentsState: FinanceUiState,
    giftState: GiftCardsUiState,
    walletState: WalletUiState,
    onPaymentsEvent: (FinanceUiEvent) -> Unit,
    onGiftEvent: (GiftCardsUiEvent) -> Unit,
    onWalletEvent: (WalletUiEvent) -> Unit,
) {
    var selectedTab by remember { mutableIntStateOf(0) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        ScrollableTabRow(
            selectedTabIndex = selectedTab,
            edgePadding = 0.dp,
        ) {
            TAB_LABELS.forEachIndexed { index, label ->
                Tab(
                    selected = selectedTab == index,
                    onClick = { selectedTab = index },
                    text = { Text(label) },
                )
            }
        }

        when (selectedTab) {
            0 -> PaymentsContent(state = paymentsState, onEvent = onPaymentsEvent)
            1 -> GiftCardsScreen(state = giftState, onEvent = onGiftEvent)
            2 -> WalletScreen(state = walletState, onEvent = onWalletEvent)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PaymentsContent(
    state: FinanceUiState,
    onEvent: (FinanceUiEvent) -> Unit,
) {
    PullToRefreshBox(
        isRefreshing = state.isLoading,
        onRefresh = { onEvent(FinanceUiEvent.LoadPayments) },
        modifier = Modifier.fillMaxSize(),
    ) {
        when {
            state.isLoading && state.payments.isEmpty() -> {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            }

            state.error != null -> {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    ErrorState(
                        message = state.error,
                        onRetry = { onEvent(FinanceUiEvent.LoadPayments) },
                    )
                }
            }

            state.payments.isEmpty() -> {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    EmptyState(message = "No payments yet.")
                }
            }

            else -> {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    item {
                        PaymentsKpiRow(payments = state.payments)
                        Spacer(modifier = Modifier.height(4.dp))
                    }
                    items(state.payments) { payment ->
                        PaymentCard(
                            payment = payment,
                            onClick = { onEvent(FinanceUiEvent.SelectPayment(payment)) },
                        )
                    }
                }
            }
        }
    }

    state.selectedPayment?.let { payment ->
        PaymentActionSheet(
            payment = payment,
            onDismiss = { onEvent(FinanceUiEvent.DismissPaymentSheet) },
            onRefund = { onEvent(FinanceUiEvent.RequestRefund(payment)) },
        )
    }

    state.showRefundConfirmFor?.let { payment ->
        AlertDialog(
            onDismissRequest = { onEvent(FinanceUiEvent.DismissRefundConfirm) },
            title = { Text("Confirm Refund") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Refund ${CurrencyUtil.formatPaise(payment.amount, payment.currency)}?")
                    Text("This action cannot be undone.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (state.refundError != null) {
                        Text(state.refundError, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = { onEvent(FinanceUiEvent.ConfirmRefund) },
                    enabled = !state.isRefunding,
                ) {
                    if (state.isRefunding) CircularProgressIndicator(modifier = Modifier.width(20.dp).height(20.dp), strokeWidth = 2.dp)
                    else Text("Refund")
                }
            },
            dismissButton = {
                TextButton(onClick = { onEvent(FinanceUiEvent.DismissRefundConfirm) }) {
                    Text("Cancel")
                }
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PaymentActionSheet(
    payment: Payment,
    onDismiss: () -> Unit,
    onRefund: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                CurrencyUtil.formatPaise(payment.amount, payment.currency),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            if (!payment.description.isNullOrBlank()) {
                Text(payment.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))
            DetailRow("Status", payment.status)
            DetailRow("Date", DateUtil.toDisplayDate(payment.createdAt))
            if (!payment.gateway.isNullOrBlank()) DetailRow("Gateway", payment.gateway)
            DetailRow("ID", payment.id.toString())
            HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))
            if (!payment.status.equals("refunded", ignoreCase = true)) {
                OutlinedButton(
                    onClick = onRefund,
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.extraLarge,
                ) {
                    Text("Request Refund", color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun PaymentsKpiRow(payments: List<Payment>) {
    val totalPaid = payments
        .filter { it.status.equals("paid", ignoreCase = true) || it.status.equals("success", ignoreCase = true) }
        .sumOf { it.amount }
    val pendingCount = payments.count { it.status.equals("pending", ignoreCase = true) }
    val failedCount = payments.count { it.status.equals("failed", ignoreCase = true) }

    @OptIn(ExperimentalLayoutApi::class)
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        maxItemsInEachRow = 3,
    ) {
        KpiCard(
            modifier = Modifier.weight(1f),
            label = "Total Paid",
            value = CurrencyUtil.formatPaise(totalPaid),
        )
        KpiCard(
            modifier = Modifier.weight(1f),
            label = "Pending",
            value = pendingCount.toString(),
        )
        KpiCard(
            modifier = Modifier.weight(1f),
            label = "Failed",
            value = failedCount.toString(),
        )
    }
}

@Composable
private fun KpiCard(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    WellnessCard(modifier = modifier) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 14.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = value,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun PaymentCard(payment: Payment, onClick: () -> Unit = {}) {
    WellnessCard(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 14.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = CurrencyUtil.formatPaise(payment.amount, payment.currency),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                StatusChip(status = payment.status)
            }

            if (!payment.description.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = payment.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            Row(
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = DateUtil.toDisplayDate(payment.createdAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!payment.gateway.isNullOrBlank()) {
                    Spacer(modifier = Modifier.width(8.dp))
                    GatewayBadge(gateway = payment.gateway)
                }
            }
        }
    }
}

@Composable
private fun GatewayBadge(gateway: String) {
    val label = when (gateway.lowercase()) {
        "razorpay" -> "Razorpay"
        "stripe" -> "Stripe"
        else -> gateway.replaceFirstChar { it.uppercase() }
    }
    Text(
        text = "· $label",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.primary,
        fontWeight = FontWeight.Medium,
    )
}

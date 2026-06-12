package com.globus.crm.feature.wallet.presentation.screen

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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.globus.crm.core.ui.ErrorState
import com.globus.crm.core.ui.GradientHeroCard
import com.globus.crm.core.ui.WellnessCard
import com.globus.crm.core.util.CurrencyUtil
import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.wallet.domain.model.Transaction
import com.globus.crm.feature.wallet.domain.model.WalletSummary
import com.globus.crm.feature.wallet.presentation.state.WalletUiEvent
import com.globus.crm.feature.wallet.presentation.state.WalletUiState

private val FILTER_LABELS = listOf("All", "Wallet", "Gift Cards", "Memberships", "Treatments")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WalletScreen(
    state: WalletUiState,
    onEvent: (WalletUiEvent) -> Unit,
) {
    var isRefreshing by remember { mutableStateOf(false) }
    LaunchedEffect(state.isLoading) { if (!state.isLoading) isRefreshing = false }

    PullToRefreshBox(
        isRefreshing = isRefreshing,
        onRefresh = { isRefreshing = true; onEvent(WalletUiEvent.Refresh) },
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        when {
            state.isLoading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            state.error != null -> ErrorState(
                message = state.error,
                onRetry = { onEvent(WalletUiEvent.Refresh) },
                modifier = Modifier.align(Alignment.Center),
            )
            state.wallet != null -> WalletContent(
                wallet = state.wallet,
                activeFilter = state.activeFilter,
                onEvent = onEvent,
            )
        }
    }

    state.selectedTransaction?.let { txn ->
        TransactionDetailSheet(
            transaction = txn,
            currency = state.wallet?.currency ?: "INR",
            onDismiss = { onEvent(WalletUiEvent.DismissTransactionDetail) },
        )
    }
}

@Composable
private fun WalletContent(
    wallet: WalletSummary,
    activeFilter: String,
    onEvent: (WalletUiEvent) -> Unit,
) {
    val filteredTxns = remember(wallet.transactions, activeFilter) {
        if (activeFilter == "All") wallet.transactions
        else wallet.transactions.filter {
            it.category.equals(activeFilter, ignoreCase = true) ||
                it.type.equals(activeFilter.replace(" ", "_"), ignoreCase = true)
        }
    }

    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            WalletKpiRow(wallet = wallet)
        }

        item {
            GradientHeroCard(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        "Balance",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = CurrencyUtil.formatPaise(wallet.balance, wallet.currency),
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }
            }
        }

        item {
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(horizontal = 0.dp),
            ) {
                items(FILTER_LABELS) { label ->
                    FilterChip(
                        selected = activeFilter == label,
                        onClick = { onEvent(WalletUiEvent.FilterTransactions(label)) },
                        label = { Text(label, style = MaterialTheme.typography.labelMedium) },
                    )
                }
            }
        }

        item {
            Text(
                "Transaction History",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
        }

        if (filteredTxns.isEmpty()) {
            item {
                Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text("No transactions found", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        } else {
            items(filteredTxns.sortedByDescending { it.date }) { txn ->
                TransactionRow(
                    transaction = txn,
                    currency = wallet.currency,
                    onClick = { onEvent(WalletUiEvent.SelectTransaction(txn)) },
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WalletKpiRow(wallet: WalletSummary) {
    val txns = wallet.transactions
    val totalPaid = txns.filter { it.direction.equals("debit", ignoreCase = true) }.sumOf { it.amount }
    val subscriptionCount = txns.count {
        it.category.equals("membership", ignoreCase = true) ||
            it.type.equals("membership", ignoreCase = true)
    }

    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        maxItemsInEachRow = 2,
    ) {
        KpiCard(Modifier.weight(1f), "Total Paid", CurrencyUtil.formatPaise(totalPaid, wallet.currency))
        KpiCard(Modifier.weight(1f), "Balance", CurrencyUtil.formatPaise(wallet.balance, wallet.currency))
        KpiCard(Modifier.weight(1f), "Subscriptions", subscriptionCount.toString())
        KpiCard(Modifier.weight(1f), "Transactions", txns.size.toString())
    }
}

@Composable
private fun KpiCard(modifier: Modifier, label: String, value: String) {
    WellnessCard(modifier = modifier) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = value,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                text = label,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun TransactionRow(transaction: Transaction, currency: String, onClick: () -> Unit) {
    val isCredit = transaction.direction.lowercase() == "credit"
    WellnessCard(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(50.dp))
                    .background(
                        if (isCredit) MaterialTheme.colorScheme.secondaryContainer
                        else MaterialTheme.colorScheme.errorContainer
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = if (isCredit) Icons.Default.ArrowDownward else Icons.Default.ArrowUpward,
                    contentDescription = null,
                    tint = if (isCredit) MaterialTheme.colorScheme.onSecondaryContainer
                           else MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.size(20.dp),
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    transaction.title,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
                if (!transaction.description.isNullOrBlank()) {
                    Text(
                        transaction.description,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    DateUtil.toDisplayDate(transaction.date),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                text = "${if (isCredit) "+" else "-"}${CurrencyUtil.formatPaise(transaction.amount, currency)}",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = if (isCredit) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.error,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TransactionDetailSheet(
    transaction: Transaction,
    currency: String,
    onDismiss: () -> Unit,
) {
    val isCredit = transaction.direction.lowercase() == "credit"
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(transaction.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            HorizontalDivider()
            ReceiptRow("Amount", "${if (isCredit) "+" else "-"}${CurrencyUtil.formatPaise(transaction.amount, currency)}")
            ReceiptRow("Date", DateUtil.toDisplayDate(transaction.date))
            ReceiptRow("Type", transaction.type)
            ReceiptRow("Category", transaction.category)
            ReceiptRow("Status", transaction.status)
            if (!transaction.reference.isNullOrBlank()) {
                ReceiptRow("Reference", transaction.reference)
            }
            if (transaction.balanceAfter != null) {
                ReceiptRow("Balance after", CurrencyUtil.formatPaise(transaction.balanceAfter, currency))
            }
        }
    }
}

@Composable
private fun ReceiptRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
    }
}

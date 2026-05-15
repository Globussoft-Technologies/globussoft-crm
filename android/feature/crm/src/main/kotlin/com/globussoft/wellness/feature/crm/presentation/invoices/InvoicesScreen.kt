package com.globussoft.wellness.feature.crm.presentation.invoices

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.domain.model.Invoice

private data class ChipItem(val label: String, val value: String?)

private val STATUS_FILTERS = listOf(
    ChipItem("All",     null),
    ChipItem("Draft",   "DRAFT"),
    ChipItem("Unpaid",  "UNPAID"),
    ChipItem("Paid",    "PAID"),
    ChipItem("Overdue", "OVERDUE"),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InvoicesScreen(
    viewModel: InvoicesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Invoices") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { viewModel.showCreate() },
                containerColor = GenericPrimary,
            ) {
                Icon(Icons.Default.Add, contentDescription = "New Invoice", tint = Color.White)
            }
        },
    ) { paddingValues ->
        PullToRefreshBox(
            isRefreshing = state.isLoading,
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {

                // ── KPI summary bar ──────────────────────────────────────────
                val paidTotal    = state.invoices.filter { it.isPaid }.sumOf { it.total }
                val overdueCount = state.invoices.count { it.isOverdue }
                val unpaidTotal  = state.invoices.filter { !it.isPaid }.sumOf { it.total }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingMd),
                    horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                ) {
                    KpiCard("Total Due", "$${"%.0f".format(unpaidTotal)}", Modifier.weight(1f))
                    KpiCard("Paid",      "$${"%.0f".format(paidTotal)}",   Modifier.weight(1f))
                    KpiCard(
                        label      = "Overdue",
                        value      = overdueCount.toString(),
                        modifier   = Modifier.weight(1f),
                        valueColor = if (overdueCount > 0) MaterialTheme.colorScheme.error
                                     else MaterialTheme.colorScheme.onSurface,
                    )
                }

                // ── Filter chips ─────────────────────────────────────────────
                LazyRow(
                    modifier              = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingXs),
                    horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                ) {
                    items(STATUS_FILTERS) { filter ->
                        FilterChip(
                            selected = state.selectedStatus == filter.value,
                            onClick  = { viewModel.setStatus(filter.value) },
                            label    = { Text(filter.label) },
                            colors   = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = GenericPrimary,
                                selectedLabelColor     = Color.White,
                            ),
                        )
                    }
                }

                // ── Content ──────────────────────────────────────────────────
                when {
                    state.isLoading && state.invoices.isEmpty() -> {
                        ShimmerList(
                            itemCount = 5,
                            modifier  = Modifier.padding(Dimens.SpacingLg),
                        )
                    }
                    state.error != null -> {
                        ErrorState(
                            message  = state.error!!,
                            onRetry  = { viewModel.refresh() },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    state.invoices.isEmpty() -> {
                        EmptyState(
                            message  = "No invoices found",
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    else -> {
                        LazyColumn(
                            modifier            = Modifier.fillMaxSize(),
                            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                            contentPadding      = PaddingValues(
                                horizontal = Dimens.SpacingLg,
                                vertical   = Dimens.SpacingSm,
                            ),
                        ) {
                            items(
                                items = state.invoices,
                                key   = { it.id },
                            ) { invoice ->
                                InvoiceCard(
                                    invoice    = invoice,
                                    onSend     = { viewModel.sendInvoice(invoice.id) },
                                    onMarkPaid = { viewModel.markPaid(invoice.id) },
                                )
                            }
                        }
                    }
                }
            }
        }

        // ── Create form sheet ────────────────────────────────────────────────
        if (state.showCreateForm) {
            InvoiceCreateSheet(
                isCreating = state.isCreating,
                formError  = state.formError,
                onDismiss  = { viewModel.dismissCreate() },
                onSave     = { dueDate, notes -> viewModel.createInvoice(dueDate, notes) },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InvoiceCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onSave: (String, String) -> Unit,
) {
    var dueDate by remember { mutableStateOf("") }
    var notes   by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("New Invoice", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value         = dueDate,
                onValueChange = { dueDate = it },
                label         = { Text("Due Date (YYYY-MM-DD)") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = notes,
                onValueChange = { notes = it },
                label         = { Text("Notes / Description") },
                modifier      = Modifier.fillMaxWidth(),
                minLines      = 2,
            )
            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Button(
                onClick  = { onSave(dueDate, notes) },
                enabled  = !isCreating,
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                if (isCreating) {
                    CircularProgressIndicator(
                        modifier    = Modifier.size(20.dp),
                        color       = Color.White,
                        strokeWidth = 2.dp,
                    )
                } else {
                    Text("Create Invoice")
                }
            }
        }
    }
}

@Composable
private fun KpiCard(
    label:      String,
    value:      String,
    modifier:   Modifier = Modifier,
    valueColor: Color    = Color.Unspecified,
) {
    Card(modifier = modifier) {
        Column(
            modifier            = Modifier.padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text       = value,
                style      = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color      = if (valueColor == Color.Unspecified) MaterialTheme.colorScheme.onSurface else valueColor,
            )
            Text(
                text  = label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun InvoiceCard(
    invoice:    Invoice,
    onSend:     () -> Unit,
    onMarkPaid: () -> Unit,
    modifier:   Modifier = Modifier,
) {
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
        ) {
            // Invoice number + status chip
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text  = invoice.invoiceNumber,
                    style = MaterialTheme.typography.titleSmall,
                )
                StatusBadge(status = invoice.status)
            }

            // Contact name
            invoice.contactName?.takeIf { it.isNotBlank() }?.let { name ->
                Spacer(Modifier.height(4.dp))
                Text(
                    text  = name,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.height(Dimens.SpacingMd))

            // Amount / Tax / Total row
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                AmountLabel(label = "Amount", amount = invoice.amount, modifier = Modifier.weight(1f))
                AmountLabel(label = "Tax",    amount = invoice.tax,    modifier = Modifier.weight(1f))
                AmountLabel(label = "Total",  amount = invoice.total,  highlight = true, modifier = Modifier.weight(1f))
            }

            // Due date
            invoice.dueDate?.takeIf { it.isNotBlank() }?.let { due ->
                Spacer(Modifier.height(4.dp))
                Text(
                    text  = "Due: $due",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (invoice.isOverdue) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // Action buttons
            val showSend     = invoice.status == "DRAFT" || invoice.status == "UNPAID"
            val showMarkPaid = !invoice.isPaid

            if (showSend || showMarkPaid) {
                Spacer(Modifier.height(Dimens.SpacingMd))
                Row(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm)) {
                    if (showSend) {
                        OutlinedButton(
                            onClick = onSend,
                            colors  = ButtonDefaults.outlinedButtonColors(contentColor = GenericPrimary),
                        ) {
                            Text("Send")
                        }
                    }
                    if (showMarkPaid) {
                        Button(
                            onClick = onMarkPaid,
                            colors  = ButtonDefaults.buttonColors(containerColor = GenericAccent),
                        ) {
                            Text("Mark Paid")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AmountLabel(
    label:     String,
    amount:    Double,
    modifier:  Modifier = Modifier,
    highlight: Boolean  = false,
) {
    Column(modifier = modifier) {
        Text(
            text  = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text  = "$%.2f".format(amount),
            style = MaterialTheme.typography.bodySmall,
            color = if (highlight) GenericPrimary else MaterialTheme.colorScheme.onSurface,
        )
    }
}

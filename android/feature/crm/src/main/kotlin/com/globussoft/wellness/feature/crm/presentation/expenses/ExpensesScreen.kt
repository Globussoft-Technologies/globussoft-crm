package com.globussoft.wellness.feature.crm.presentation.expenses

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
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
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.domain.model.Expense

private data class CategoryFilter(val label: String, val value: String?)

private val CATEGORY_FILTERS = listOf(
    CategoryFilter("All",       null),
    CategoryFilter("Travel",    "Travel"),
    CategoryFilter("Software",  "Software"),
    CategoryFilter("Office",    "Office"),
    CategoryFilter("Marketing", "Marketing"),
    CategoryFilter("Other",     "Other"),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExpensesScreen(
    viewModel: ExpensesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Expenses")
                        Text(
                            text  = "${state.expenses.size} expense${if (state.expenses.size == 1) "" else "s"}",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick        = { viewModel.showCreate() },
                containerColor = GenericPrimary,
            ) {
                Icon(Icons.Default.Add, contentDescription = "New Expense", tint = Color.White)
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
                // ── Category filter chips ──────────────────────────────────────
                LazyRow(
                    modifier              = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                    horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                ) {
                    items(CATEGORY_FILTERS) { filter ->
                        FilterChip(
                            selected = state.selectedCategory == filter.value,
                            onClick  = { viewModel.setCategory(filter.value) },
                            label    = { Text(filter.label) },
                            colors   = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = GenericPrimary,
                                selectedLabelColor     = Color.White,
                            ),
                        )
                    }
                }

                // ── Content ───────────────────────────────────────────────────
                when {
                    state.error != null -> {
                        ErrorState(
                            message  = state.error!!,
                            onRetry  = { viewModel.refresh() },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    state.isLoading && state.expenses.isEmpty() -> {
                        ShimmerList(modifier = Modifier.fillMaxSize())
                    }
                    state.expenses.isEmpty() -> {
                        EmptyState(
                            message  = "No expenses found",
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    else -> {
                        LazyColumn(
                            modifier            = Modifier.fillMaxSize(),
                            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                            contentPadding      = androidx.compose.foundation.layout.PaddingValues(
                                horizontal = Dimens.SpacingLg,
                                vertical   = Dimens.SpacingSm,
                            ),
                        ) {
                            items(
                                items = state.expenses,
                                key   = { it.id },
                            ) { expense ->
                                ExpenseCard(
                                    expense   = expense,
                                    onApprove = { viewModel.approve(expense.id) },
                                    onReject  = { viewModel.reject(expense.id) },
                                )
                            }
                        }
                    }
                }
            }
        }

        // ── Create form sheet ────────────────────────────────────────────────
        if (state.showCreateForm) {
            ExpenseCreateSheet(
                isCreating = state.isCreating,
                formError  = state.formError,
                onDismiss  = { viewModel.dismissCreate() },
                onSave     = { title, amount, category, date, notes ->
                    viewModel.createExpense(title, amount, category, date, notes)
                },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ExpenseCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onSave: (String, String, String, String, String) -> Unit,
) {
    var title    by remember { mutableStateOf("") }
    var amount   by remember { mutableStateOf("") }
    var category by remember { mutableStateOf("Other") }
    var date     by remember { mutableStateOf("") }
    var notes    by remember { mutableStateOf("") }
    val categories = listOf("Travel", "Software", "Office", "Marketing", "Other")

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("New Expense", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value         = title,
                onValueChange = { title = it },
                label         = { Text("Title *") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = amount,
                onValueChange = { amount = it },
                label         = { Text("Amount") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = date,
                onValueChange = { date = it },
                label         = { Text("Date (YYYY-MM-DD)") },
                modifier      = Modifier.fillMaxWidth(),
            )
            Text("Category", style = MaterialTheme.typography.labelMedium)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(categories) { cat ->
                    FilterChip(
                        selected = category == cat,
                        onClick  = { category = cat },
                        label    = { Text(cat) },
                        colors   = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = GenericPrimary,
                            selectedLabelColor     = Color.White,
                        ),
                    )
                }
            }
            OutlinedTextField(
                value         = notes,
                onValueChange = { notes = it },
                label         = { Text("Notes") },
                modifier      = Modifier.fillMaxWidth(),
            )
            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Button(
                onClick  = { onSave(title, amount, category, date, notes) },
                enabled  = title.isNotBlank() && !isCreating,
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Creating…" else "Add Expense")
            }
        }
    }
}

@Composable
private fun ExpenseCard(
    expense:   Expense,
    onApprove: () -> Unit,
    onReject:  () -> Unit,
    modifier:  Modifier = Modifier,
) {
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
        ) {
            // ── Row 1: description + amount ───────────────────────────────────
            Row(
                modifier          = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text     = expense.description,
                    style    = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(Dimens.SpacingSm))
                Text(
                    text       = "$${"%.2f".format(expense.amount)}",
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color      = GenericPrimary,
                )
            }

            Spacer(Modifier.height(Dimens.SpacingXs))

            // ── Row 2: category chip + status chip ────────────────────────────
            Row(
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                expense.category?.takeIf { it.isNotBlank() }?.let { cat ->
                    SuggestionChip(
                        onClick = {},
                        label   = { Text(cat, style = MaterialTheme.typography.labelSmall) },
                        colors  = SuggestionChipDefaults.suggestionChipColors(
                            containerColor = GenericPrimary.copy(alpha = 0.10f),
                            labelColor     = GenericPrimary,
                        ),
                    )
                }
                StatusChip(status = expense.status)
            }

            Spacer(Modifier.height(Dimens.SpacingXs))

            // ── Row 3: date + staff name ──────────────────────────────────────
            Row(
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                expense.date?.takeIf { it.isNotBlank() }?.let { date ->
                    Text(
                        text  = date,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                expense.userName?.takeIf { it.isNotBlank() }?.let { name ->
                    Text(
                        text  = name,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // ── Approve / Reject buttons (always visible for now) ────────────
            if (expense.isPending) {
                Spacer(Modifier.height(Dimens.SpacingSm))
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                ) {
                    OutlinedButton(
                        onClick  = onApprove,
                        modifier = Modifier.weight(1f),
                        colors   = ButtonDefaults.outlinedButtonColors(
                            contentColor = GenericAccent,
                        ),
                    ) {
                        Text("Approve")
                    }
                    OutlinedButton(
                        onClick  = onReject,
                        modifier = Modifier.weight(1f),
                        colors   = ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.error,
                        ),
                    ) {
                        Text("Reject")
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusChip(status: String) {
    val (containerColor, labelColor) = when (status.uppercase()) {
        "APPROVED" -> GenericAccent.copy(alpha = 0.15f) to GenericAccent
        "REJECTED" -> MaterialTheme.colorScheme.error.copy(alpha = 0.15f) to MaterialTheme.colorScheme.error
        else       -> MaterialTheme.colorScheme.tertiary.copy(alpha = 0.15f) to MaterialTheme.colorScheme.tertiary
    }
    SuggestionChip(
        onClick = {},
        label   = {
            Text(
                text  = status.lowercase().replaceFirstChar { it.uppercase() },
                style = MaterialTheme.typography.labelSmall,
            )
        },
        colors  = SuggestionChipDefaults.suggestionChipColors(
            containerColor = containerColor,
            labelColor     = labelColor,
        ),
    )
}

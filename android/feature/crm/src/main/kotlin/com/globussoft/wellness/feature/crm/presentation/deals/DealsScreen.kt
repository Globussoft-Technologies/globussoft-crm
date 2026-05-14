package com.globussoft.wellness.feature.crm.presentation.deals

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.outlined.TrendingUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
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

private val STATUS_FILTERS = listOf(
    null     to "All",
    "OPEN"   to "Open",
    "WON"    to "Won",
    "LOST"   to "Lost",
)

private val STAGE_FILTERS = listOf(
    null              to "All Stages",
    "Prospecting"     to "Prospecting",
    "Qualification"   to "Qualification",
    "Proposal"        to "Proposal",
    "Negotiation"     to "Negotiation",
    "Closed Won"      to "Closed Won",
    "Closed Lost"     to "Closed Lost",
)

private val DEAL_STAGES = listOf(
    "Prospecting", "Qualification", "Proposal", "Negotiation", "Closed Won", "Closed Lost",
)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun DealsScreen(
    viewModel: DealsViewModel = hiltViewModel(),
    onDealClick: (String) -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text       = "Deals",
                            style      = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.SemiBold,
                        )
                        if (state.deals.isNotEmpty()) {
                            Text(
                                text  = "${state.deals.size} deal${if (state.deals.size != 1) "s" else ""}",
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
        floatingActionButton = {
            FloatingActionButton(
                onClick        = { viewModel.showAdd() },
                containerColor = GenericPrimary,
                contentColor   = Color.White,
            ) {
                Icon(Icons.Default.Add, contentDescription = "Add Deal")
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.deals.isNotEmpty(),
            onRefresh    = viewModel::refresh,
            modifier     = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when {
                state.isLoading && state.deals.isEmpty() ->
                    ShimmerList(itemCount = 8, modifier = Modifier.fillMaxSize())

                state.error != null && state.deals.isEmpty() ->
                    ErrorState(
                        message  = state.error!!,
                        onRetry  = viewModel::refresh,
                        modifier = Modifier.fillMaxSize(),
                    )

                else -> LazyColumn(
                    contentPadding      = PaddingValues(bottom = Dimens.SpacingXxl),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    modifier            = Modifier.fillMaxSize(),
                ) {
                    // Status filter chips
                    item(key = "status-chips") {
                        LazyRow(
                            horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                            contentPadding        = PaddingValues(
                                horizontal = Dimens.SpacingLg,
                                vertical   = Dimens.SpacingMd,
                            ),
                        ) {
                            items(STATUS_FILTERS) { (value, label) ->
                                FilterChip(
                                    selected = state.selectedStatus == value,
                                    onClick  = { viewModel.setStatus(value) },
                                    label    = { Text(label) },
                                    colors   = FilterChipDefaults.filterChipColors(
                                        selectedContainerColor = GenericPrimary.copy(alpha = 0.15f),
                                        selectedLabelColor     = GenericPrimary,
                                    ),
                                )
                            }
                        }
                    }

                    // Stage filter chips
                    item(key = "stage-chips") {
                        LazyRow(
                            horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                            contentPadding        = PaddingValues(
                                horizontal = Dimens.SpacingLg,
                                vertical   = Dimens.SpacingXs,
                            ),
                        ) {
                            items(STAGE_FILTERS) { (value, label) ->
                                FilterChip(
                                    selected = state.selectedStage == value,
                                    onClick  = { viewModel.setStage(value) },
                                    label    = { Text(label) },
                                    colors   = FilterChipDefaults.filterChipColors(
                                        selectedContainerColor = GenericAccent.copy(alpha = 0.15f),
                                        selectedLabelColor     = GenericAccent,
                                    ),
                                )
                            }
                        }
                    }

                    if (state.deals.isEmpty() && !state.isLoading) {
                        item {
                            EmptyState(
                                message  = "No deals found.",
                                icon     = Icons.Outlined.TrendingUp,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    } else {
                        items(state.deals, key = { it.id }) { deal ->
                            val dismissState = rememberSwipeToDismissBoxState(
                                confirmValueChange = { value ->
                                    if (value == SwipeToDismissBoxValue.EndToStart) {
                                        viewModel.confirmDelete(deal.id)
                                    }
                                    false // Don't auto-dismiss — let the dialog confirm
                                },
                            )
                            SwipeToDismissBox(
                                state            = dismissState,
                                backgroundContent = {
                                    Box(
                                        modifier          = Modifier
                                            .fillMaxSize()
                                            .padding(horizontal = Dimens.SpacingLg)
                                            .padding(end = Dimens.SpacingLg),
                                        contentAlignment = Alignment.CenterEnd,
                                    ) {
                                        Icon(
                                            imageVector        = Icons.Default.Delete,
                                            contentDescription = "Delete",
                                            tint               = MaterialTheme.colorScheme.error,
                                        )
                                    }
                                },
                                enableDismissFromStartToEnd = false,
                                modifier = Modifier.padding(horizontal = Dimens.SpacingLg),
                            ) {
                                DealCard(
                                    deal         = deal,
                                    onClick      = { onDealClick(deal.id) },
                                    onLongPress  = { viewModel.showEdit(deal) },
                                    modifier     = Modifier.fillMaxWidth(),
                                )
                            }
                        }
                    }
                }
            }
        }

        // Delete confirmation dialog
        if (state.deleteConfirmId != null) {
            AlertDialog(
                onDismissRequest = { viewModel.cancelDelete() },
                title   = { Text("Delete Deal") },
                text    = { Text("Are you sure you want to delete this deal? This action cannot be undone.") },
                confirmButton = {
                    Button(
                        onClick = { viewModel.deleteDeal(state.deleteConfirmId!!) },
                        colors  = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                        ),
                    ) { Text("Delete") }
                },
                dismissButton = {
                    TextButton(onClick = { viewModel.cancelDelete() }) { Text("Cancel") }
                },
            )
        }

        // Add / Edit bottom sheet
        if (state.showAddForm) {
            val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
            ModalBottomSheet(
                onDismissRequest = { viewModel.dismissForm() },
                sheetState       = sheetState,
            ) {
                DealFormContent(
                    state     = state,
                    viewModel = viewModel,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DealFormContent(
    state: DealsUiState,
    viewModel: DealsViewModel,
) {
    val editing = state.editingDeal

    var title       by remember(editing?.id ?: "new") { mutableStateOf(editing?.title ?: "") }
    var amount      by remember(editing?.id ?: "new") { mutableStateOf(editing?.amount?.toLong()?.toString() ?: "") }
    var stage       by remember(editing?.id ?: "new") { mutableStateOf(editing?.stage ?: DEAL_STAGES.first()) }
    var probability by remember(editing?.id ?: "new") { mutableStateOf(editing?.probability?.toString() ?: "") }

    Column(
        modifier              = Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = Dimens.SpacingLg)
            .padding(bottom = Dimens.SpacingLg),
        verticalArrangement   = Arrangement.spacedBy(Dimens.SpacingMd),
    ) {
        Text(
            text       = if (editing != null) "Edit Deal" else "Add Deal",
            style      = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
        )

        OutlinedTextField(
            value        = title,
            onValueChange = { title = it },
            label        = { Text("Title *") },
            modifier     = Modifier.fillMaxWidth(),
            singleLine   = true,
        )

        OutlinedTextField(
            value         = amount,
            onValueChange = { amount = it },
            label         = { Text("Amount") },
            modifier      = Modifier.fillMaxWidth(),
            singleLine    = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )

        Text(
            text  = "Stage",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        LazyRow(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm)) {
            items(DEAL_STAGES) { s ->
                FilterChip(
                    selected = stage == s,
                    onClick  = { stage = s },
                    label    = { Text(s, style = MaterialTheme.typography.labelSmall) },
                    colors   = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = GenericPrimary.copy(alpha = 0.15f),
                        selectedLabelColor     = GenericPrimary,
                    ),
                )
            }
        }

        OutlinedTextField(
            value         = probability,
            onValueChange = { probability = it },
            label         = { Text("Probability (0-100)") },
            modifier      = Modifier.fillMaxWidth(),
            singleLine    = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )

        if (state.formError != null) {
            Text(
                text  = state.formError,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }

        Button(
            onClick  = {
                if (title.isNotBlank()) {
                    viewModel.saveDeal(title.trim(), amount, stage, probability)
                }
            },
            enabled  = title.isNotBlank() && !state.isCreating,
            modifier = Modifier.fillMaxWidth(),
            colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
        ) {
            if (state.isCreating) {
                CircularProgressIndicator(
                    modifier = Modifier.height(Dimens.SpacingLg),
                    color    = Color.White,
                    strokeWidth = Dimens.SpacingXs,
                )
            } else {
                Text(if (editing != null) "Save Changes" else "Add Deal")
            }
        }

        TextButton(
            onClick  = { viewModel.dismissForm() },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Cancel") }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DealCard(
    deal:       Deal,
    onClick:    () -> Unit,
    onLongPress: () -> Unit = {},
    modifier:   Modifier = Modifier,
) {
    WellnessCard(
        modifier = modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick     = onClick,
                onLongClick = onLongPress,
            ),
    ) {
        Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.Top,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text       = deal.title,
                        style      = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    deal.contactName?.takeIf { it.isNotBlank() }?.let { cn ->
                        Text(
                            text  = cn,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                // Amount badge
                Box(
                    modifier = Modifier.padding(start = Dimens.SpacingMd),
                ) {
                    SuggestionChip(
                        onClick = {},
                        label   = {
                            Text(
                                text       = "${"%.0f".format(deal.amount)}",
                                fontWeight = FontWeight.Bold,
                            )
                        },
                        colors  = SuggestionChipDefaults.suggestionChipColors(
                            containerColor = GenericAccent.copy(alpha = 0.12f),
                            labelColor     = GenericAccent,
                        ),
                    )
                }
            }

            Spacer(Modifier.height(Dimens.SpacingXs))

            Row(
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                // Stage chip
                SuggestionChip(
                    onClick = {},
                    label   = { Text(deal.stage, style = MaterialTheme.typography.labelSmall) },
                    colors  = SuggestionChipDefaults.suggestionChipColors(
                        containerColor = GenericPrimary.copy(alpha = 0.10f),
                        labelColor     = GenericPrimary,
                    ),
                )

                deal.pipelineName?.takeIf { it.isNotBlank() }?.let { pn ->
                    Text(
                        text  = pn,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(Modifier.height(Dimens.SpacingXs))

            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                deal.expectedClose?.takeIf { it.isNotBlank() }?.let { ec ->
                    Text(
                        text  = "Close: ${ec.take(10)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    text  = "${deal.probability}% probability",
                    style = MaterialTheme.typography.bodySmall,
                    color = when {
                        deal.probability >= 75 -> GenericAccent
                        deal.probability >= 40 -> GenericPrimary
                        else                   -> MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        }
    }
}

package com.globussoft.wellness.feature.crm.presentation.tickets

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.PriorityBadge
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.domain.model.Ticket

private data class ChipItem(val label: String, val value: String?)

private val STATUS_FILTERS = listOf(
    ChipItem("All",         null),
    ChipItem("Open",        "OPEN"),
    ChipItem("In Progress", "IN_PROGRESS"),
    ChipItem("Resolved",    "RESOLVED"),
)

private val PRIORITY_FILTERS = listOf(
    ChipItem("All",    null),
    ChipItem("Low",    "LOW"),
    ChipItem("Medium", "MEDIUM"),
    ChipItem("High",   "HIGH"),
    ChipItem("Urgent", "URGENT"),
)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun TicketsScreen(
    onTicketClick: (String) -> Unit = {},
    viewModel:     TicketsViewModel  = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // Delete confirmation dialog
    state.deleteConfirmId?.let { idToDelete ->
        AlertDialog(
            onDismissRequest = { viewModel.cancelDelete() },
            title            = { Text("Resolve Ticket") },
            text             = { Text("Mark this ticket as Resolved?") },
            confirmButton    = {
                Button(
                    onClick = { viewModel.deleteTicket(idToDelete) },
                    colors  = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                ) { Text("Resolve") }
            },
            dismissButton    = {
                TextButton(onClick = { viewModel.cancelDelete() }) { Text("Cancel") }
            },
        )
    }

    // Add/Edit bottom sheet
    if (state.showAddForm) {
        val editing = state.editingTicket
        var subject     by remember(editing?.id ?: "new") { mutableStateOf(editing?.subject ?: "") }
        var description by remember(editing?.id ?: "new") { mutableStateOf(editing?.description ?: "") }
        var priority    by remember(editing?.id ?: "new") { mutableStateOf(editing?.priority ?: "MEDIUM") }

        ModalBottomSheet(
            onDismissRequest = { viewModel.dismissForm() },
            sheetState       = sheetState,
        ) {
            Column(
                modifier              = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingMd)
                    .navigationBarsPadding(),
                verticalArrangement   = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                Text(
                    text  = if (editing != null) "Edit Ticket" else "New Ticket",
                    style = MaterialTheme.typography.titleLarge,
                )

                OutlinedTextField(
                    value         = subject,
                    onValueChange = { subject = it },
                    label         = { Text("Subject *") },
                    singleLine    = true,
                    modifier      = Modifier.fillMaxWidth(),
                )

                OutlinedTextField(
                    value         = description,
                    onValueChange = { description = it },
                    label         = { Text("Description") },
                    maxLines      = 3,
                    modifier      = Modifier.fillMaxWidth(),
                )

                Text("Priority", style = MaterialTheme.typography.labelLarge)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm)) {
                    items(listOf("LOW", "MEDIUM", "HIGH", "URGENT")) { p ->
                        FilterChip(
                            selected = priority == p,
                            onClick  = { priority = p },
                            label    = { Text(p) },
                            colors   = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = GenericPrimary,
                                selectedLabelColor     = Color.White,
                            ),
                        )
                    }
                }

                state.formError?.let { err ->
                    Text(
                        text  = err,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }

                Button(
                    onClick  = { viewModel.saveTicket(subject, description, priority) },
                    enabled  = subject.isNotBlank() && !state.isCreating,
                    modifier = Modifier.fillMaxWidth(),
                    colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
                ) {
                    if (state.isCreating) {
                        CircularProgressIndicator(color = Color.White, modifier = Modifier.height(18.dp).width(18.dp))
                    } else {
                        Text(if (editing != null) "Update" else "Create")
                    }
                }

                Spacer(Modifier.height(Dimens.SpacingSm))
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Support Tickets")
                        Text(
                            text  = "${state.tickets.size} ticket${if (state.tickets.size == 1) "" else "s"}",
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
                onClick        = { viewModel.showAdd() },
                containerColor = GenericPrimary,
                contentColor   = Color.White,
            ) {
                Icon(Icons.Default.Add, contentDescription = "Add Ticket")
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
                // ── Status filter chips ──────────────────────────────────────────
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

                // ── Priority filter chips ────────────────────────────────────────
                LazyRow(
                    modifier              = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingXs),
                    horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                ) {
                    items(PRIORITY_FILTERS) { filter ->
                        FilterChip(
                            selected = state.selectedPriority == filter.value,
                            onClick  = { viewModel.setPriority(filter.value) },
                            label    = { Text(filter.label) },
                            colors   = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = GenericPrimary,
                                selectedLabelColor     = Color.White,
                            ),
                        )
                    }
                }

                // ── Content ──────────────────────────────────────────────────────
                when {
                    state.error != null -> {
                        ErrorState(
                            message  = state.error!!,
                            onRetry  = { viewModel.refresh() },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    state.tickets.isEmpty() && !state.isLoading -> {
                        EmptyState(
                            message  = "No tickets found",
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
                                items = state.tickets,
                                key   = { it.id },
                            ) { ticket ->
                                val dismissState = rememberSwipeToDismissBoxState(
                                    confirmValueChange = { value ->
                                        if (value == SwipeToDismissBoxValue.EndToStart) {
                                            viewModel.confirmDelete(ticket.id)
                                        }
                                        false // don't auto-dismiss visually
                                    }
                                )
                                SwipeToDismissBox(
                                    state             = dismissState,
                                    enableDismissFromStartToEnd = false,
                                    backgroundContent = {
                                        Box(
                                            modifier         = Modifier
                                                .fillMaxSize()
                                                .background(
                                                    color  = MaterialTheme.colorScheme.error,
                                                    shape  = RoundedCornerShape(12.dp),
                                                )
                                                .padding(end = Dimens.SpacingLg),
                                            contentAlignment = Alignment.CenterEnd,
                                        ) {
                                            Icon(
                                                imageVector        = Icons.Default.Delete,
                                                contentDescription = "Resolve",
                                                tint               = Color.White,
                                            )
                                        }
                                    },
                                ) {
                                    TicketCard(
                                        ticket        = ticket,
                                        onTicketClick = { onTicketClick(ticket.id) },
                                        onLongPress   = { viewModel.showEdit(ticket) },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TicketCard(
    ticket:        Ticket,
    onTicketClick: () -> Unit,
    onLongPress:   () -> Unit = {},
    modifier:      Modifier   = Modifier,
) {
    WellnessCard(
        modifier = modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick     = onTicketClick,
                onLongClick = onLongPress,
            ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
        ) {
            // Subject
            Text(
                text  = ticket.subject,
                style = MaterialTheme.typography.titleSmall,
            )

            // Description
            ticket.description?.takeIf { it.isNotBlank() }?.let { desc ->
                Spacer(Modifier.height(2.dp))
                Text(
                    text     = desc,
                    style    = MaterialTheme.typography.bodySmall,
                    color    = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Spacer(Modifier.height(Dimens.SpacingMd))

            // Status + Priority + Assignee row
            Row(
                verticalAlignment     = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
            ) {
                StatusBadge(status = ticket.status)
                PriorityBadge(priority = ticket.priority)
                ticket.assigneeName?.takeIf { it.isNotBlank() }?.let { assignee ->
                    Spacer(Modifier.width(Dimens.SpacingXs))
                    Text(
                        text  = assignee,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (ticket.breached) {
                    Spacer(Modifier.width(Dimens.SpacingXs))
                    SlaBadge()
                }
            }

            // Contact name
            ticket.contactName?.takeIf { it.isNotBlank() }?.let { cName ->
                Spacer(Modifier.height(Dimens.SpacingXs))
                Text(
                    text  = cName,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun SlaBadge(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .background(
                color  = MaterialTheme.colorScheme.error,
                shape  = RoundedCornerShape(100),
            )
            .padding(horizontal = 10.dp, vertical = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = "SLA BREACHED",
            style = MaterialTheme.typography.labelSmall,
            color = Color.White,
        )
    }
}

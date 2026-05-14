package com.globussoft.wellness.feature.crm.presentation.tasks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
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
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.domain.model.CrmTask

private data class StatusFilter(val label: String, val value: String?)

private val STATUS_FILTERS = listOf(
    StatusFilter("Pending",   "PENDING"),
    StatusFilter("Completed", "COMPLETED"),
    StatusFilter("All",       null),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(
    viewModel: TasksViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Tasks")
                        Text(
                            text  = "${state.tasks.size} task${if (state.tasks.size == 1) "" else "s"}",
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
                Icon(Icons.Default.Add, contentDescription = "Add Task")
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
                        .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
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

                // ── Content ──────────────────────────────────────────────────────
                when {
                    state.error != null -> {
                        ErrorState(
                            message  = state.error!!,
                            onRetry  = { viewModel.refresh() },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    state.tasks.isEmpty() && !state.isLoading -> {
                        EmptyState(
                            message  = "No tasks found",
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
                                items = state.tasks,
                                key   = { it.id },
                            ) { task ->
                                TaskCard(
                                    task            = task,
                                    onCompleteClick = { viewModel.completeTask(task.id) },
                                )
                            }
                        }
                    }
                }
            }
        }

        // Add Task bottom sheet
        if (state.showAddForm) {
            val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
            ModalBottomSheet(
                onDismissRequest = { viewModel.dismissForm() },
                sheetState       = sheetState,
            ) {
                TaskFormContent(
                    state     = state,
                    viewModel = viewModel,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TaskFormContent(
    state: TasksUiState,
    viewModel: TasksViewModel,
) {
    var title       by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    var dueDate     by rememberSaveable { mutableStateOf("") }

    Column(
        modifier            = Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = Dimens.SpacingLg)
            .padding(bottom = Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
    ) {
        Text(
            text       = "Add Task",
            style      = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
        )

        OutlinedTextField(
            value         = title,
            onValueChange = { title = it },
            label         = { Text("Title *") },
            modifier      = Modifier.fillMaxWidth(),
            singleLine    = true,
        )

        OutlinedTextField(
            value         = description,
            onValueChange = { description = it },
            label         = { Text("Description (optional)") },
            modifier      = Modifier.fillMaxWidth(),
            minLines      = 2,
            maxLines      = 4,
        )

        OutlinedTextField(
            value         = dueDate,
            onValueChange = { dueDate = it },
            label         = { Text("Due Date (optional)") },
            placeholder   = { Text("YYYY-MM-DD") },
            modifier      = Modifier.fillMaxWidth(),
            singleLine    = true,
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
                    viewModel.createTask(title.trim(), description, dueDate)
                }
            },
            enabled  = title.isNotBlank() && !state.isCreating,
            modifier = Modifier.fillMaxWidth(),
            colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
        ) {
            if (state.isCreating) {
                CircularProgressIndicator(
                    modifier    = Modifier.height(Dimens.SpacingLg),
                    color       = Color.White,
                    strokeWidth = Dimens.SpacingXs,
                )
            } else {
                Text("Add Task")
            }
        }

        TextButton(
            onClick  = { viewModel.dismissForm() },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Cancel") }
    }
}

@Composable
private fun TaskCard(
    task:            CrmTask,
    onCompleteClick: () -> Unit,
    modifier:        Modifier = Modifier,
) {
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Text content
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text  = task.title,
                    style = MaterialTheme.typography.titleSmall,
                )
                task.description?.takeIf { it.isNotBlank() }?.let { desc ->
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text     = desc,
                        style    = MaterialTheme.typography.bodySmall,
                        color    = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                    )
                }
                Spacer(Modifier.height(Dimens.SpacingXs))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    verticalAlignment     = Alignment.CenterVertically,
                ) {
                    task.dueDate?.takeIf { it.isNotBlank() }?.let { due ->
                        Text(
                            text  = due,
                            style = MaterialTheme.typography.labelSmall,
                            color = if (task.isOverdue)
                                MaterialTheme.colorScheme.error
                            else
                                MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    task.assigneeName?.takeIf { it.isNotBlank() }?.let { assignee ->
                        Text(
                            text  = assignee,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    task.contactName?.takeIf { it.isNotBlank() }?.let { cName ->
                        Text(
                            text  = cName,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            // Checkbox to complete
            if (task.isPending) {
                Spacer(Modifier.width(Dimens.SpacingMd))
                IconButton(onClick = onCompleteClick) {
                    Icon(
                        imageVector        = Icons.Outlined.RadioButtonUnchecked,
                        contentDescription = "Mark complete",
                        tint               = GenericPrimary,
                    )
                }
            } else {
                Spacer(Modifier.width(Dimens.SpacingMd))
                Icon(
                    imageVector        = Icons.Outlined.CheckCircle,
                    contentDescription = "Completed",
                    tint               = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

package com.globussoft.wellness.feature.crm.presentation.projects

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.draw.clip
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
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

private fun projectStatusColor(status: String): Color = when (status.uppercase()) {
    "ACTIVE"    -> GenericPrimary
    "COMPLETED" -> Color(0xFF2E7D32)
    "PLANNING"  -> Color(0xFFE65100)
    else        -> Color(0xFF757575)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProjectsScreen(
    viewModel: ProjectsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Projects") },
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
                Icon(Icons.Default.Add, contentDescription = "New Project", tint = Color.White)
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            val statusFilters = listOf(
                "All" to null, "Planning" to "PLANNING", "Active" to "ACTIVE", "Completed" to "COMPLETED",
            )
            LazyRow(
                modifier              = Modifier.fillMaxWidth().padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingXs),
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
            ) {
                items(statusFilters) { filter ->
                    FilterChip(
                        selected = state.selectedStatus == filter.second,
                        onClick  = { viewModel.setStatus(filter.second) },
                        label    = { Text(filter.first) },
                        colors   = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = GenericPrimary,
                            selectedLabelColor     = Color.White,
                        ),
                    )
                }
            }

            PullToRefreshBox(
                isRefreshing = state.isLoading && state.projects.isNotEmpty(),
                onRefresh    = { viewModel.refresh() },
                modifier     = Modifier.fillMaxSize(),
            ) {
                when {
                    state.isLoading && state.projects.isEmpty() ->
                        ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                    state.error != null && state.projects.isEmpty() ->
                        ErrorState(message = state.error!!, onRetry = { viewModel.refresh() }, modifier = Modifier.fillMaxSize())
                    state.projects.isEmpty() ->
                        EmptyState(message = "No projects found.", modifier = Modifier.fillMaxSize())
                    else ->
                        LazyColumn(
                            contentPadding      = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                        ) {
                            items(state.projects) { project ->
                                ProjectCard(project = project)
                            }
                        }
                }
            }
        }
    }

    if (state.showCreateForm) {
        ProjectCreateSheet(
            isCreating = state.isCreating,
            formError  = state.formError,
            onDismiss  = { viewModel.dismissCreate() },
            onSave     = { name, desc, deadline -> viewModel.createProject(name, desc, deadline) },
        )
    }
}

@Composable
private fun ProjectCard(project: Map<String, Any>) {
    val name       = project["name"] as? String ?: "Untitled"
    val status     = project["status"] as? String ?: "PLANNING"
    val deadline   = project["deadline"] as? String ?: project["dueDate"] as? String ?: ""
    val assignees  = (project["assignees"] as? List<*>)?.size ?: 0
    val statusColor = projectStatusColor(status)

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(Dimens.SpacingMd),
        ) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(statusColor.copy(alpha = 0.15f))
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                ) {
                    Text(status, style = MaterialTheme.typography.labelSmall, color = statusColor, fontWeight = FontWeight.Bold)
                }
            }
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                if (deadline.isNotBlank()) {
                    Text("Due: ${deadline.take(10)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (assignees > 0) {
                    Text("$assignees member${if (assignees == 1) "" else "s"}", style = MaterialTheme.typography.labelSmall, color = GenericPrimary)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProjectCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onSave: (String, String, String) -> Unit,
) {
    var name        by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var deadline    by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier            = Modifier.padding(horizontal = 24.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("New Project", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Project Name") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = description, onValueChange = { description = it }, label = { Text("Description (optional)") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            OutlinedTextField(value = deadline, onValueChange = { deadline = it }, label = { Text("Deadline (YYYY-MM-DD)") }, modifier = Modifier.fillMaxWidth())
            formError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Button(
                onClick  = { onSave(name, description, deadline) },
                enabled  = !isCreating && name.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Creating…" else "Create Project")
            }
        }
    }
}

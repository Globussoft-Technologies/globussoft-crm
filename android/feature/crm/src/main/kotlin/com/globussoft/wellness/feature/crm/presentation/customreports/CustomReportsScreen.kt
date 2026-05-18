package com.globussoft.wellness.feature.crm.presentation.customreports

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
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

private val ENTITY_TYPES = listOf("Contacts", "Deals", "Tickets", "Leads", "Invoices")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CustomReportsScreen(
    viewModel: CustomReportsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Custom Reports") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { viewModel.showCreate() }, containerColor = GenericPrimary) {
                Icon(Icons.Default.Add, contentDescription = "Create Report", tint = Color.White)
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
            when {
                state.isLoading && state.reports.isEmpty() -> ShimmerList(
                    itemCount = 5,
                    modifier  = Modifier.padding(Dimens.SpacingLg),
                )
                state.error != null -> ErrorState(
                    message  = state.error!!,
                    onRetry  = { viewModel.refresh() },
                    modifier = Modifier.fillMaxSize(),
                )
                state.reports.isEmpty() -> EmptyState(
                    message  = "No custom reports yet",
                    modifier = Modifier.fillMaxSize(),
                )
                else -> LazyColumn(
                    modifier            = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                    contentPadding      = PaddingValues(
                        horizontal = Dimens.SpacingLg,
                        vertical   = Dimens.SpacingSm,
                    ),
                ) {
                    items(state.reports, key = { it["id"]?.toString() ?: it.hashCode().toString() }) { report ->
                        CustomReportCard(report = report)
                    }
                }
            }
        }

        if (state.showCreateForm) {
            CustomReportCreateSheet(
                isCreating = state.isCreating,
                formError  = state.formError,
                onDismiss  = { viewModel.dismissCreate() },
                onCreate   = { name, entityType -> viewModel.createReport(name, entityType) },
            )
        }
    }
}

@Composable
private fun CustomReportCard(
    report: Map<String, Any>,
    modifier: Modifier = Modifier,
) {
    val name       = report["name"] as? String ?: "Untitled"
    val entity     = report["entity"] as? String ?: report["entityType"] as? String ?: ""
    val createdAt  = report["createdAt"] as? String ?: ""
    val dateLabel  = if (createdAt.length >= 10) createdAt.substring(0, 10) else createdAt

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(text = name, style = MaterialTheme.typography.titleSmall)
                if (entity.isNotBlank()) {
                    Text(
                        text  = entity,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (dateLabel.isNotBlank()) {
                    Text(
                        text  = dateLabel,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            OutlinedButton(
                onClick = { /* Run report — non-functional UI */ },
                modifier = Modifier.padding(start = 8.dp),
            ) {
                Text("Run", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CustomReportCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onCreate: (String, String) -> Unit,
) {
    var name       by remember { mutableStateOf("") }
    var entityType by remember { mutableStateOf(ENTITY_TYPES.first()) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .padding(horizontal = 24.dp, vertical = 8.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Create Custom Report", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value         = name,
                onValueChange = { name = it },
                label         = { Text("Report Name *") },
                modifier      = Modifier.fillMaxWidth(),
            )
            Text("Entity Type", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ENTITY_TYPES.forEach { type ->
                    SuggestionChip(
                        onClick = { entityType = type },
                        label   = { Text(type, style = MaterialTheme.typography.labelSmall) },
                        colors  = SuggestionChipDefaults.suggestionChipColors(
                            containerColor = if (entityType == type) GenericPrimary else MaterialTheme.colorScheme.surfaceVariant,
                        ),
                        border  = null,
                    )
                }
            }
            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(4.dp))
            Button(
                onClick  = { onCreate(name, entityType) },
                enabled  = name.isNotBlank() && !isCreating,
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Creating..." else "Create Report")
            }
        }
    }
}

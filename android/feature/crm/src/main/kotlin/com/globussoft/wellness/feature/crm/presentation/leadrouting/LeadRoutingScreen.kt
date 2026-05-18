package com.globussoft.wellness.feature.crm.presentation.leadrouting

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
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LeadRoutingScreen(
    viewModel: LeadRoutingViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Lead Routing") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { viewModel.showCreate() }, containerColor = GenericPrimary) {
                Icon(Icons.Default.Add, contentDescription = "Add Rule", tint = Color.White)
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
                state.isLoading && state.rules.isEmpty() -> ShimmerList(
                    itemCount = 5,
                    modifier  = Modifier.padding(Dimens.SpacingLg),
                )
                state.error != null -> ErrorState(
                    message  = state.error!!,
                    onRetry  = { viewModel.refresh() },
                    modifier = Modifier.fillMaxSize(),
                )
                state.rules.isEmpty() -> EmptyState(
                    message  = "No routing rules yet",
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
                    items(state.rules, key = { it["id"]?.toString() ?: it.hashCode().toString() }) { rule ->
                        LeadRoutingRuleCard(rule = rule)
                    }
                }
            }
        }

        if (state.showCreateForm) {
            LeadRoutingCreateSheet(
                isCreating = state.isCreating,
                formError  = state.formError,
                onDismiss  = { viewModel.dismissCreate() },
                onCreate   = { name, assignTo, type -> viewModel.createRule(name, assignTo, type) },
            )
        }
    }
}

@Composable
private fun LeadRoutingRuleCard(
    rule: Map<String, Any>,
    modifier: Modifier = Modifier,
) {
    @Suppress("UNCHECKED_CAST")
    val name       = rule["name"] as? String ?: "Untitled Rule"
    val type       = rule["type"] as? String ?: rule["ruleType"] as? String ?: "ROUND_ROBIN"
    val assignedTo = rule["assignedTo"] as? String ?: rule["userId"] as? String ?: ""

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(text = name, style = MaterialTheme.typography.titleSmall)
                if (assignedTo.isNotBlank()) {
                    Text(
                        text  = "Assign to: $assignedTo",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            RuleTypeChip(type = type)
        }
    }
}

@Composable
private fun RuleTypeChip(type: String) {
    val (label, color) = when (type.uppercase().replace(" ", "_").replace("-", "_")) {
        "ROUND_ROBIN"    -> "Round Robin"    to GenericPrimary
        "SKILL_BASED"    -> "Skill Based"    to GenericAccent
        "TERRITORY"      -> "Territory"      to Color(0xFF8B5CF6)
        else             -> type             to Color(0xFF6B7280)
    }
    SuggestionChip(
        onClick = {},
        label   = {
            Text(
                text  = label,
                style = MaterialTheme.typography.labelSmall,
                color = Color.White,
            )
        },
        colors = SuggestionChipDefaults.suggestionChipColors(containerColor = color),
        border = null,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LeadRoutingCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onCreate: (String, String, String) -> Unit,
) {
    val ruleTypes = listOf("Round Robin", "Skill Based", "Territory")
    var name     by remember { mutableStateOf("") }
    var assignTo by remember { mutableStateOf("") }
    var type     by remember { mutableStateOf("Round Robin") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .padding(horizontal = 24.dp, vertical = 8.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Add Routing Rule", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value         = name,
                onValueChange = { name = it },
                label         = { Text("Rule Name *") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = assignTo,
                onValueChange = { assignTo = it },
                label         = { Text("Assign To") },
                modifier      = Modifier.fillMaxWidth(),
            )
            Text("Type", style = MaterialTheme.typography.labelMedium)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(ruleTypes) { t ->
                    FilterChip(
                        selected = type == t,
                        onClick  = { type = t },
                        label    = { Text(t) },
                        colors   = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = GenericPrimary,
                            selectedLabelColor     = Color.White,
                        ),
                    )
                }
            }
            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(4.dp))
            Button(
                onClick  = {
                    val apiType = type.uppercase().replace(" ", "_")
                    onCreate(name, assignTo, apiType)
                },
                enabled  = name.isNotBlank() && !isCreating,
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Creating…" else "Create Rule")
            }
        }
    }
}

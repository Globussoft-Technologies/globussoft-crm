package com.globussoft.wellness.feature.crm.presentation.abtests

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

private val StatusColors = mapOf(
    "DRAFT"     to Color(0xFF6B7280),
    "RUNNING"   to Color(0xFF22C55E),
    "COMPLETED" to Color(0xFF3B82F6),
    "PAUSED"    to Color(0xFFF97316),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AbTestsScreen(
    viewModel: AbTestsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("A/B Tests") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { viewModel.showCreate() }, containerColor = GenericPrimary) {
                Icon(Icons.Default.Add, contentDescription = "Create A/B Test", tint = Color.White)
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
                state.isLoading && state.tests.isEmpty() -> ShimmerList(
                    itemCount = 5,
                    modifier  = Modifier.padding(Dimens.SpacingLg),
                )
                state.error != null -> ErrorState(
                    message  = state.error!!,
                    onRetry  = { viewModel.refresh() },
                    modifier = Modifier.fillMaxSize(),
                )
                state.tests.isEmpty() -> EmptyState(
                    message  = "No A/B tests yet",
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
                    items(state.tests, key = { it["id"]?.toString() ?: it.hashCode().toString() }) { test ->
                        AbTestCard(test = test)
                    }
                }
            }
        }

        if (state.showCreateForm) {
            AbTestCreateSheet(
                isCreating = state.isCreating,
                formError  = state.formError,
                onDismiss  = { viewModel.dismissCreate() },
                onCreate   = { name, variantA, variantB -> viewModel.createTest(name, variantA, variantB) },
            )
        }
    }
}

@Composable
private fun AbTestCard(
    test: Map<String, Any>,
    modifier: Modifier = Modifier,
) {
    val name     = test["name"] as? String ?: "Untitled"
    val status   = test["status"] as? String ?: "DRAFT"
    val variantA = (test["variantA"] as? Map<*, *>)?.get("name") as? String
        ?: test["variantAName"] as? String
        ?: "Variant A"
    val variantB = (test["variantB"] as? Map<*, *>)?.get("name") as? String
        ?: test["variantBName"] as? String
        ?: "Variant B"
    val statusColor = StatusColors[status] ?: Color(0xFF6B7280)

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
        ) {
            Row(
                modifier          = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text     = name,
                    style    = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                SuggestionChip(
                    onClick = {},
                    label   = {
                        Text(
                            text  = status,
                            style = MaterialTheme.typography.labelSmall,
                            color = Color.White,
                        )
                    },
                    colors = SuggestionChipDefaults.suggestionChipColors(containerColor = statusColor),
                    border = null,
                )
            }
            Text(
                text  = "A: $variantA  vs  B: $variantB",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AbTestCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onCreate: (String, String, String) -> Unit,
) {
    var name     by remember { mutableStateOf("") }
    var variantA by remember { mutableStateOf("") }
    var variantB by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .padding(horizontal = 24.dp, vertical = 8.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Create A/B Test", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value         = name,
                onValueChange = { name = it },
                label         = { Text("Test Name *") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = variantA,
                onValueChange = { variantA = it },
                label         = { Text("Variant A Name") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = variantB,
                onValueChange = { variantB = it },
                label         = { Text("Variant B Name") },
                modifier      = Modifier.fillMaxWidth(),
            )
            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(4.dp))
            Button(
                onClick  = { onCreate(name, variantA, variantB) },
                enabled  = name.isNotBlank() && !isCreating,
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Creating..." else "Create A/B Test")
            }
        }
    }
}

package com.globussoft.wellness.feature.crm.presentation.territories

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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerritoriesScreen(
    viewModel: TerritoriesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Territories") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { viewModel.showCreate() }, containerColor = GenericPrimary) {
                Icon(Icons.Default.Add, contentDescription = "Add Territory", tint = Color.White)
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
                state.isLoading && state.territories.isEmpty() -> ShimmerList(
                    itemCount = 5,
                    modifier  = Modifier.padding(Dimens.SpacingLg),
                )
                state.error != null -> ErrorState(
                    message  = state.error!!,
                    onRetry  = { viewModel.refresh() },
                    modifier = Modifier.fillMaxSize(),
                )
                state.territories.isEmpty() -> EmptyState(
                    message  = "No territories yet",
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
                    items(state.territories, key = { it["id"]?.toString() ?: it.hashCode().toString() }) { territory ->
                        TerritoryCard(territory = territory)
                    }
                }
            }
        }

        if (state.showCreateForm) {
            TerritoryCreateSheet(
                isCreating = state.isCreating,
                formError  = state.formError,
                onDismiss  = { viewModel.dismissCreate() },
                onCreate   = { name, region -> viewModel.createTerritory(name, region) },
            )
        }
    }
}

@Composable
private fun TerritoryCard(
    territory: Map<String, Any>,
    modifier: Modifier = Modifier,
) {
    @Suppress("UNCHECKED_CAST")
    val name        = territory["name"] as? String ?: "Untitled"
    val region      = territory["region"] as? String ?: territory["description"] as? String ?: ""
    val repCount    = (territory["assignedRepsCount"] as? Number)?.toInt()
        ?: (territory["repIds"] as? List<*>)?.size
        ?: 0

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(text = name, style = MaterialTheme.typography.titleSmall)
                if (region.isNotBlank()) {
                    Text(
                        text  = region,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (repCount > 0) {
                SuggestionChip(
                    onClick = {},
                    label   = {
                        Text(
                            text  = "$repCount rep${if (repCount == 1) "" else "s"}",
                            style = MaterialTheme.typography.labelSmall,
                            color = Color.White,
                        )
                    },
                    colors = SuggestionChipDefaults.suggestionChipColors(containerColor = GenericPrimary),
                    border = null,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TerritoryCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onCreate: (String, String) -> Unit,
) {
    var name   by remember { mutableStateOf("") }
    var region by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .padding(horizontal = 24.dp, vertical = 8.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Add Territory", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value         = name,
                onValueChange = { name = it },
                label         = { Text("Territory Name *") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = region,
                onValueChange = { region = it },
                label         = { Text("Region / Description") },
                modifier      = Modifier.fillMaxWidth(),
            )
            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(4.dp))
            Button(
                onClick  = { onCreate(name, region) },
                enabled  = name.isNotBlank() && !isCreating,
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Creating…" else "Create Territory")
            }
        }
    }
}

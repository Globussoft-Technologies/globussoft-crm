package com.globussoft.wellness.feature.crm.presentation.quotas

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
import androidx.compose.material3.LinearProgressIndicator
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
fun QuotasScreen(
    viewModel: QuotasViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Sales Quotas") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { viewModel.showCreate() }, containerColor = GenericPrimary) {
                Icon(Icons.Default.Add, contentDescription = "Add Quota", tint = Color.White)
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
                state.isLoading && state.quotas.isEmpty() -> ShimmerList(
                    itemCount = 5,
                    modifier  = Modifier.padding(Dimens.SpacingLg),
                )
                state.error != null -> ErrorState(
                    message  = state.error!!,
                    onRetry  = { viewModel.refresh() },
                    modifier = Modifier.fillMaxSize(),
                )
                state.quotas.isEmpty() -> EmptyState(
                    message  = "No quotas yet",
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
                    items(state.quotas, key = { it["id"]?.toString() ?: it.hashCode().toString() }) { quota ->
                        QuotaCard(quota = quota)
                    }
                }
            }
        }

        if (state.showCreateForm) {
            QuotaCreateSheet(
                isCreating = state.isCreating,
                formError  = state.formError,
                onDismiss  = { viewModel.dismissCreate() },
                onCreate   = { repName, target -> viewModel.createQuota(repName, target) },
            )
        }
    }
}

@Composable
private fun QuotaCard(
    quota: Map<String, Any>,
    modifier: Modifier = Modifier,
) {
    @Suppress("UNCHECKED_CAST")
    val repName  = quota["repName"] as? String ?: quota["userId"] as? String ?: "Unknown"
    val target   = (quota["target"] as? Number)?.toDouble() ?: 0.0
    val attained = (quota["attained"] as? Number)?.toDouble() ?: 0.0
    val period   = quota["period"] as? String ?: ""
    val progress = if (target > 0) (attained / target).toFloat().coerceIn(0f, 1f) else 0f
    val pct      = (progress * 100).toInt()

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
        ) {
            Row(
                modifier          = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(text = repName, style = MaterialTheme.typography.titleSmall)
                    if (period.isNotBlank()) {
                        Text(
                            text  = period,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Text(
                    text  = "$pct%",
                    style = MaterialTheme.typography.labelLarge,
                    color = if (pct >= 100) GenericPrimary else MaterialTheme.colorScheme.onSurface,
                )
            }
            LinearProgressIndicator(
                progress     = { progress },
                modifier     = Modifier.fillMaxWidth(),
                color        = GenericPrimary,
                trackColor   = GenericPrimary.copy(alpha = 0.12f),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text  = "Attained: ${"$%.0f".format(attained)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text  = "Target: ${"$%.0f".format(target)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun QuotaCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onCreate: (String, String) -> Unit,
) {
    var repName by remember { mutableStateOf("") }
    var target  by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .padding(horizontal = 24.dp, vertical = 8.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Add Quota", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value         = repName,
                onValueChange = { repName = it },
                label         = { Text("Rep Name *") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = target,
                onValueChange = { target = it },
                label         = { Text("Target ($) *") },
                modifier      = Modifier.fillMaxWidth(),
            )
            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(4.dp))
            Button(
                onClick  = { onCreate(repName, target) },
                enabled  = repName.isNotBlank() && target.isNotBlank() && !isCreating,
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Creating…" else "Create Quota")
            }
        }
    }
}

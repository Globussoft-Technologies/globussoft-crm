package com.globussoft.wellness.feature.crm.presentation.contracts

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

private fun contractStatusColor(status: String): Color = when (status.uppercase()) {
    "ACTIVE"  -> Color(0xFF2E7D32)
    "EXPIRED" -> Color(0xFFC62828)
    else      -> Color(0xFF757575)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContractsScreen(
    viewModel: ContractsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Contracts") },
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
                Icon(Icons.Default.Add, contentDescription = "New Contract", tint = Color.White)
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
                "All" to null, "Draft" to "DRAFT", "Active" to "ACTIVE", "Expired" to "EXPIRED",
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
                isRefreshing = state.isLoading && state.contracts.isNotEmpty(),
                onRefresh    = { viewModel.refresh() },
                modifier     = Modifier.fillMaxSize(),
            ) {
                when {
                    state.isLoading && state.contracts.isEmpty() ->
                        ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                    state.error != null && state.contracts.isEmpty() ->
                        ErrorState(message = state.error!!, onRetry = { viewModel.refresh() }, modifier = Modifier.fillMaxSize())
                    state.contracts.isEmpty() ->
                        EmptyState(message = "No contracts found.", modifier = Modifier.fillMaxSize())
                    else ->
                        LazyColumn(
                            contentPadding      = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                        ) {
                            items(state.contracts) { contract ->
                                ContractCard(contract = contract)
                            }
                        }
                }
            }
        }
    }

    if (state.showCreateForm) {
        ContractCreateSheet(
            isCreating = state.isCreating,
            formError  = state.formError,
            onDismiss  = { viewModel.dismissCreate() },
            onSave     = { title, value, start, end -> viewModel.createContract(title, value, start, end) },
        )
    }
}

@Composable
private fun ContractCard(contract: Map<String, Any>) {
    val title        = contract["title"] as? String ?: "Untitled"
    val counterparty = contract["counterparty"] as? String ?: contract["contactName"] as? String ?: ""
    val value        = (contract["value"] as? Number)?.toDouble() ?: 0.0
    val status       = contract["status"] as? String ?: "DRAFT"
    val endDate      = contract["endDate"] as? String ?: contract["expiryDate"] as? String ?: ""
    val statusColor  = contractStatusColor(status)

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(Dimens.SpacingMd),
        ) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(statusColor.copy(alpha = 0.15f))
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                ) {
                    Text(status, style = MaterialTheme.typography.labelSmall, color = statusColor, fontWeight = FontWeight.Bold)
                }
            }
            if (counterparty.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(counterparty, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("$${"%,.0f".format(value)}", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium, color = GenericPrimary)
                if (endDate.isNotBlank()) {
                    Text("Expires: ${endDate.take(10)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ContractCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onSave: (String, String, String, String) -> Unit,
) {
    var title     by remember { mutableStateOf("") }
    var value     by remember { mutableStateOf("") }
    var startDate by remember { mutableStateOf("") }
    var endDate   by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier            = Modifier.padding(horizontal = 24.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("New Contract", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Contract Title") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = value, onValueChange = { value = it }, label = { Text("Value ($)") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = startDate, onValueChange = { startDate = it }, label = { Text("Start Date (YYYY-MM-DD)") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = endDate, onValueChange = { endDate = it }, label = { Text("End Date (YYYY-MM-DD)") }, modifier = Modifier.fillMaxWidth())
            formError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Button(
                onClick  = { onSave(title, value, startDate, endDate) },
                enabled  = !isCreating && title.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Creating…" else "Create Contract")
            }
        }
    }
}

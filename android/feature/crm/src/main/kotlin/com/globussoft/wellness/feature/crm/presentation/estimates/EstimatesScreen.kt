package com.globussoft.wellness.feature.crm.presentation.estimates

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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.domain.model.Estimate
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private data class ChipItem(val label: String, val value: String?)

private val STATUS_FILTERS = listOf(
    ChipItem("All",      null),
    ChipItem("Draft",    "DRAFT"),
    ChipItem("Sent",     "SENT"),
    ChipItem("Accepted", "ACCEPTED"),
    ChipItem("Rejected", "REJECTED"),
)

/** Returns the background color for an estimate status chip. */
private fun estimateStatusColor(status: String): Color = when (status.uppercase()) {
    "ACCEPTED" -> Color(0xFF2E7D32)
    "REJECTED" -> Color(0xFFC62828)
    "SENT"     -> Color(0xFFF9A825)
    else       -> Color(0xFF757575) // DRAFT / unknown
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EstimatesScreen(
    viewModel: EstimatesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Estimates / Quotes") },
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
                Icon(Icons.Default.Add, contentDescription = "New Estimate", tint = Color.White)
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

                // ── Filter chips ─────────────────────────────────────────────────
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

                // ── Content ──────────────────────────────────────────────────────
                when {
                    state.isLoading && state.estimates.isEmpty() -> {
                        ShimmerList(
                            itemCount = 5,
                            modifier  = Modifier.padding(Dimens.SpacingLg),
                        )
                    }
                    state.error != null -> {
                        ErrorState(
                            message  = state.error!!,
                            onRetry  = { viewModel.refresh() },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    state.estimates.isEmpty() -> {
                        EmptyState(
                            message  = "No estimates found",
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
                                items = state.estimates,
                                key   = { it.id },
                            ) { estimate ->
                                EstimateCard(
                                    estimate = estimate,
                                    onSend   = { viewModel.sendEstimate(estimate.id) },
                                )
                            }
                        }
                    }
                }
            }
        }

        // ── Create form sheet ────────────────────────────────────────────────
        if (state.showCreateForm) {
            EstimateCreateSheet(
                isCreating = state.isCreating,
                formError  = state.formError,
                onDismiss  = { viewModel.dismissCreate() },
                onSave     = { validUntil, notes -> viewModel.createEstimate(validUntil, notes) },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EstimateCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onSave: (String, String) -> Unit,
) {
    var validUntil by remember { mutableStateOf("") }
    var notes      by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("New Estimate", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value         = validUntil,
                onValueChange = { validUntil = it },
                label         = { Text("Valid Until (YYYY-MM-DD)") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = notes,
                onValueChange = { notes = it },
                label         = { Text("Notes / Description") },
                modifier      = Modifier.fillMaxWidth(),
                minLines      = 2,
            )
            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Button(
                onClick  = { onSave(validUntil, notes) },
                enabled  = !isCreating,
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Creating…" else "Create Estimate")
            }
        }
    }
}

@Composable
private fun EstimateCard(
    estimate: Estimate,
    onSend:   () -> Unit,
    modifier: Modifier = Modifier,
) {
    val today      = remember { Date() }
    val dateParser = remember { SimpleDateFormat("yyyy-MM-dd", Locale.US) }

    val isExpired = remember(estimate.validUntil) {
        estimate.validUntil?.let { raw ->
            runCatching { dateParser.parse(raw)?.before(today) }.getOrNull() ?: false
        } ?: false
    }

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
        ) {
            // Estimate number + status chip
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text  = estimate.estimateNumber,
                    style = MaterialTheme.typography.titleSmall,
                )
                EstimateStatusChip(status = estimate.status)
            }

            // Contact name
            estimate.contactName?.takeIf { it.isNotBlank() }?.let { name ->
                Spacer(Modifier.height(4.dp))
                Text(
                    text  = name,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.height(Dimens.SpacingMd))

            // Total amount
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text       = "${"$%.2f".format(estimate.total)}",
                    style      = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color      = GenericPrimary,
                )
                // Line items count
                if (estimate.lineItems.isNotEmpty()) {
                    Text(
                        text  = "${estimate.lineItems.size} item${if (estimate.lineItems.size == 1) "" else "s"}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // Valid until / expired
            estimate.validUntil?.takeIf { it.isNotBlank() }?.let { validUntil ->
                Spacer(Modifier.height(4.dp))
                if (isExpired) {
                    Text(
                        text  = "Expired",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                } else {
                    Text(
                        text  = "Valid until: $validUntil",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // Action buttons
            val showSend = estimate.status == "DRAFT"
            if (showSend) {
                Spacer(Modifier.height(Dimens.SpacingSm))
                OutlinedButton(
                    onClick  = onSend,
                    modifier = Modifier.fillMaxWidth(),
                    colors   = ButtonDefaults.outlinedButtonColors(contentColor = GenericAccent),
                ) {
                    Text("Send to Client")
                }
            }
        }
    }
}

@Composable
private fun EstimateStatusChip(
    status:   String,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .background(
                color  = estimateStatusColor(status),
                shape  = RoundedCornerShape(100),
            )
            .padding(horizontal = 10.dp, vertical = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = status.replace('_', ' ').lowercase()
                .replaceFirstChar { it.uppercase() },
            style = MaterialTheme.typography.labelSmall,
            color = Color.White,
        )
    }
}

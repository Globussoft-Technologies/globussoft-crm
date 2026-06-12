package com.globus.crm.feature.health.presentation.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.globus.crm.core.ui.ErrorState
import com.globus.crm.core.ui.WellnessCard
import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.health.domain.model.Prescription
import com.globus.crm.feature.health.presentation.state.PrescriptionsUiEvent
import com.globus.crm.feature.health.presentation.state.PrescriptionsUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PrescriptionsScreen(
    state: PrescriptionsUiState,
    onEvent: (PrescriptionsUiEvent) -> Unit,
) {
    var isRefreshing by remember { mutableStateOf(false) }
    LaunchedEffect(state.isLoading) { if (!state.isLoading) isRefreshing = false }

    PullToRefreshBox(
        isRefreshing = isRefreshing,
        onRefresh = { isRefreshing = true; onEvent(PrescriptionsUiEvent.Refresh) },
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        when {
            state.isLoading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            state.permissionBlocked -> ErrorState(
                message = "Prescription access is not enabled for your account. Contact your clinic.",
                onRetry = { onEvent(PrescriptionsUiEvent.Refresh) },
                modifier = Modifier.align(Alignment.Center),
            )
            state.error != null -> ErrorState(
                message = state.error,
                onRetry = { onEvent(PrescriptionsUiEvent.Refresh) },
                modifier = Modifier.align(Alignment.Center),
            )
            state.prescriptions.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No prescriptions found", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> LazyColumn(
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(state.prescriptions) { prescription ->
                    PrescriptionCard(
                        prescription = prescription,
                        onClick = { onEvent(PrescriptionsUiEvent.RequestViewPdf(prescription.id)) },
                    )
                }
            }
        }
    }

    // PDF download confirmation dialog
    if (state.showPdfConfirm) {
        AlertDialog(
            onDismissRequest = { onEvent(PrescriptionsUiEvent.DismissPdfConfirm) },
            title = { Text("Open prescription PDF?") },
            text = { Text("This will download the document to view it in the app.") },
            confirmButton = {
                Button(onClick = { onEvent(PrescriptionsUiEvent.ConfirmViewPdf) }) {
                    Text("Open")
                }
            },
            dismissButton = {
                TextButton(onClick = { onEvent(PrescriptionsUiEvent.DismissPdfConfirm) }) {
                    Text("Cancel")
                }
            },
        )
    }
}

@Composable
private fun PrescriptionCard(prescription: Prescription, onClick: () -> Unit) {
    WellnessCard(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Row(
            modifier = Modifier.padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = prescription.serviceName ?: "Prescription",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
                if (!prescription.doctorName.isNullOrBlank()) {
                    Text(
                        text = prescription.doctorName,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    text = DateUtil.toDisplayDate(prescription.visitDate),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
                // Drug count badge with secondaryContainer (mint)
                Surface(
                    shape = MaterialTheme.shapes.extraSmall,
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    modifier = Modifier.padding(top = 4.dp),
                ) {
                    Text(
                        text = "${prescription.drugs.size} medication${if (prescription.drugs.size != 1) "s" else ""}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }
            Icon(
                Icons.Default.PictureAsPdf,
                contentDescription = "View PDF",
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(24.dp),
            )
        }
    }
}
